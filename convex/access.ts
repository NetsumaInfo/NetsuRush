import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { authComponent } from "./auth";

// Résultat lu par le LoginGate renderer : connecté ? accès beta ? rôle.
// P0 = beta OUVERTE : OPEN_BETA=true → tout compte connecté a l'accès.
// Bascule ALLOWLIST plus tard : mettre OPEN_BETA=false, alors seul un `betaGrants.role != "pending"` passe.
export const getAccess = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return { authenticated: false, hasAccess: false, role: null as string | null };
    }
    const openBeta = process.env.OPEN_BETA === "true";
    const grant = await ctx.db
      .query("betaGrants")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    const role = grant?.role ?? "pending";
    const hasAccess = openBeta || role !== "pending";
    return { authenticated: true, hasAccess, role, userId: user._id };
  },
});

// Grant manuel (future allowlist). Internal : appelé depuis le dashboard Convex / un outil admin,
// jamais exposé au client. Ex : npx convex run access:grantAccess '{"userId":"…","role":"member"}'
export const grantAccess = internalMutation({
  args: { userId: v.string(), role: v.optional(v.string()), note: v.optional(v.string()) },
  handler: async (ctx, { userId, role, note }) => {
    const existing = await ctx.db
      .query("betaGrants")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const patch = { role: role ?? "member", grantedAt: Date.now(), note };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("betaGrants", { userId, ...patch });
    }
  },
});
