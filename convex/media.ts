import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { authComponent } from "./auth";
import type { Id } from "./_generated/dataModel";

const HASH = /^[0-9a-f]{64}$/;
const MAX_HASHES = 64;
const RETRY_WINDOW_MS = 60 * 60 * 1000;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function coalesceMediaHashes(
  existing: string[],
  requested: string[],
): string[] {
  const incoming = [...new Set(requested)];
  if (
    !incoming.length ||
    incoming.length > MAX_HASHES ||
    incoming.some((hash) => !HASH.test(hash))
  ) {
    throw new Error("invalid media request");
  }
  return [
    ...new Set([...existing.filter((hash) => HASH.test(hash)), ...incoming]),
  ].slice(0, MAX_HASHES);
}

async function requireMember(ctx: QueryCtx, projectId: Id<"projects">) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("not signed in");
  const member = await ctx.db
    .query("projectMembers")
    .withIndex("by_project_user", (q) =>
      q.eq("projectId", projectId).eq("userId", user._id),
    )
    .unique();
  if (!member) throw new Error("not a member of this project");
  return user;
}

async function notifyHolders(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  requesterId: string,
) {
  const members = await ctx.db
    .query("projectMembers")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  const now = Date.now();
  for (const member of members) {
    if (member.userId === requesterId) continue;
    const existing = await ctx.db
      .query("projectInbox")
      .withIndex("by_user_project", (q) =>
        q.eq("userId", member.userId).eq("projectId", projectId),
      )
      .unique();
    if (existing) {
      const actors = existing.actors.includes(requesterId)
        ? existing.actors
        : [...existing.actors, requesterId];
      await ctx.db.patch(existing._id, {
        actors,
        mediaRequested: true,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("projectInbox", {
        userId: member.userId,
        projectId,
        actors: [requesterId],
        mediaRequested: true,
        keyRequested: false,
        updatedAt: now,
      });
    }
  }
}

/** Coalesces every missing hash for this requester into one bounded project row. */
export const request = mutation({
  args: { projectId: v.id("projects"), hashes: v.array(v.string()) },
  handler: async (ctx, { projectId, hashes }) => {
    const user = await requireMember(ctx, projectId);
    const existing = await ctx.db
      .query("projectMediaRequests")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", projectId).eq("userId", user._id),
      )
      .unique();
    const merged = coalesceMediaHashes(existing?.hashes ?? [], hashes);
    const now = Date.now();
    const unchanged =
      existing &&
      merged.length === existing.hashes.length &&
      merged.every((hash, index) => hash === existing.hashes[index]);
    if (unchanged && now - existing.updatedAt < RETRY_WINDOW_MS) {
      return { status: "coalesced" as const, hashes: merged.length };
    }
    const row = {
      hashes: merged,
      updatedAt: now,
      expiresAt: now + REQUEST_TTL_MS,
    };
    if (existing) await ctx.db.patch(existing._id, row);
    else
      await ctx.db.insert("projectMediaRequests", {
        projectId,
        userId: user._id,
        ...row,
      });
    await notifyHolders(ctx, projectId, user._id);
    return { status: "requested" as const, hashes: merged.length };
  },
});

/** Lets an online member see that somebody is waiting for originals, without a live subscription. */
export const list = query({
  args: { projectId: v.id("projects"), now: v.number() },
  handler: async (ctx, { projectId, now }) => {
    await requireMember(ctx, projectId);
    const rows = await ctx.db
      .query("projectMediaRequests")
      .withIndex("by_project_expiry", (q) =>
        q.eq("projectId", projectId).gt("expiresAt", now),
      )
      .take(10);
    return rows.map((row) => ({
      requesterId: row.userId,
      hashes: row.hashes,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
    }));
  },
});
