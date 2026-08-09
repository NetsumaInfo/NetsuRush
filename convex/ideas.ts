import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { authComponent } from "./auth";

const STATUSES = ["open", "planned", "done", "declined"] as const;

// Liste publique (lecture sans auth). `myVote` rempli si connecté.
export const list = query({
  args: { sort: v.optional(v.union(v.literal("votes"), v.literal("recent"))) },
  handler: async (ctx, { sort }) => {
    const ideas =
      sort === "recent"
        ? await ctx.db.query("ideas").order("desc").take(200)
        : await ctx.db.query("ideas").withIndex("by_votes").order("desc").take(200);

    const user = await authComponent.safeGetAuthUser(ctx);
    let mine = new Set<string>();
    if (user) {
      const votes = await ctx.db
        .query("ideaVotes")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();
      mine = new Set(votes.map((x) => x.ideaId as string));
    }
    return ideas.map((idea) => ({
      _id: idea._id,
      title: idea.title,
      description: idea.description,
      authorName: idea.authorName,
      status: idea.status,
      votes: idea.votes,
      createdAt: idea.createdAt,
      myVote: mine.has(idea._id as string),
    }));
  },
});

// Proposer une idée (auth requise). Le vote de l'auteur est implicite (votes: 1).
export const create = mutation({
  args: { title: v.string(), description: v.string() },
  handler: async (ctx, { title, description }) => {
    const user = await authComponent.getAuthUser(ctx); // throw si non connecté
    const t = title.trim();
    const d = description.trim();
    if (t.length < 4 || t.length > 120) throw new Error("TITLE_LENGTH");
    if (d.length > 2000) throw new Error("DESCRIPTION_LENGTH");
    const ideaId = await ctx.db.insert("ideas", {
      title: t,
      description: d,
      authorId: user._id,
      authorName: user.name ?? "anonyme",
      status: "open",
      votes: 1,
      createdAt: Date.now(),
    });
    await ctx.db.insert("ideaVotes", { ideaId, userId: user._id });
    return ideaId;
  },
});

// Vote / dé-vote (toggle, auth requise). Compteur dénormalisé maintenu ici.
export const toggleVote = mutation({
  args: { ideaId: v.id("ideas") },
  handler: async (ctx, { ideaId }) => {
    const user = await authComponent.getAuthUser(ctx);
    const idea = await ctx.db.get(ideaId);
    if (!idea) throw new Error("IDEA_NOT_FOUND");
    const existing = await ctx.db
      .query("ideaVotes")
      .withIndex("by_idea_user", (q) => q.eq("ideaId", ideaId).eq("userId", user._id))
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
      await ctx.db.patch(ideaId, { votes: Math.max(0, idea.votes - 1) });
      return { voted: false as const };
    }
    await ctx.db.insert("ideaVotes", { ideaId, userId: user._id });
    await ctx.db.patch(ideaId, { votes: idea.votes + 1 });
    return { voted: true as const };
  },
});

// Changement de statut (roadmap). Internal : dashboard Convex / outil admin.
// Ex : npx convex run ideas:setStatus '{"ideaId":"…","status":"planned"}'
export const setStatus = internalMutation({
  args: { ideaId: v.id("ideas"), status: v.string() },
  handler: async (ctx, { ideaId, status }) => {
    if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
      throw new Error("STATUS_INVALID");
    }
    await ctx.db.patch(ideaId, { status });
  },
});
