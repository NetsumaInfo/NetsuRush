import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { authComponent } from "./auth";
import type { Id } from "./_generated/dataModel";

async function access(ctx: QueryCtx, projectId: Id<"projects">) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("Sign in required");
  const project = await ctx.db.get(projectId);
  const member = await ctx.db.query("projectMembers").withIndex("by_project_user", (q) =>
    q.eq("projectId", projectId).eq("userId", user._id)).unique();
  if (project?.surface !== "collection" || !member) throw new Error("Collection unavailable");
  return { userId: user._id, member };
}

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const { userId, member } = await access(ctx, projectId);
    const entries = await ctx.db.query("collectionEntries").withIndex("by_project", (q) => q.eq("projectId", projectId)).take(5001);
    if (entries.length > 5000) throw new Error("Collection capacity exceeded");
    return { userId, role: member.role, canDeleteOthers: member.canDeleteOthers === true,
      entries: entries.map(({ entryId, contributorId, removed }) => ({ entryId, contributorId, removed })) };
  },
});

export const register = mutation({
  args: { projectId: v.id("projects"), entryIds: v.array(v.string()) },
  handler: async (ctx, { projectId, entryIds }) => {
    const { userId, member } = await access(ctx, projectId);
    if (member.role !== "owner" && member.role !== "editor") throw new Error("Read-only collection");
    if (!entryIds.length || entryIds.length > 100) throw new Error("Invalid entry batch");
    const existing = await ctx.db.query("collectionEntries").withIndex("by_project", (q) => q.eq("projectId", projectId)).take(5001);
    const byId = new Map(existing.map((row) => [row.entryId, row]));
    const unique = [...new Set(entryIds)];
    if (existing.length + unique.filter((id) => !byId.has(id)).length > 5000) throw new Error("Collection capacity exceeded");
    for (const entryId of unique) {
      if (!/^ci_[a-zA-Z0-9_-]{1,100}$/.test(entryId)) throw new Error("Invalid entry identity");
      const previous = byId.get(entryId);
      if (previous) {
        if (previous.contributorId !== userId || previous.removed) throw new Error("Entry identity is already reserved");
      } else await ctx.db.insert("collectionEntries", { projectId, entryId, contributorId: userId, removed: false, createdAt: Date.now() });
    }
    return { userId };
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects"), entryId: v.string() },
  handler: async (ctx, { projectId, entryId }) => {
    const { userId, member } = await access(ctx, projectId);
    const entry = await ctx.db.query("collectionEntries").withIndex("by_project_entry", (q) =>
      q.eq("projectId", projectId).eq("entryId", entryId)).unique();
    // The owner always governs their own collection; an editor removes what they contributed, and
    // anything else only once the owner delegated removal to them.
    const governs = member.role === "owner" || member.canDeleteOthers === true;
    if (!entry || (member.role !== "owner" && member.role !== "editor") ||
        (entry.contributorId !== userId && !governs)) throw new Error("Global removal is not permitted");
    if (!entry.removed) await ctx.db.patch(entry._id, { removed: true });
  },
});

export const setPermission = mutation({
  args: { projectId: v.id("projects"), userId: v.string(), allowed: v.boolean() },
  handler: async (ctx, { projectId, userId, allowed }) => {
    const { member } = await access(ctx, projectId);
    if (member.role !== "owner") throw new Error("Only the owner may delegate removal");
    const target = await ctx.db.query("projectMembers").withIndex("by_project_user", (q) =>
      q.eq("projectId", projectId).eq("userId", userId)).unique();
    // Only an editor can hold it: the owner governs the collection anyway, and a viewer writes
    // nothing at all — granting it there would leave a permission that survives a later promotion.
    if (!target || target.role !== "editor") throw new Error("Only an editor can be granted removal");
    await ctx.db.patch(target._id, { canDeleteOthers: allowed });
  },
});
