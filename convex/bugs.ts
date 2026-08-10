import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// Un compte ne doit pas pouvoir noyer le salon : au-delà de ce nombre de rapports par heure, le
// relais répond 429 et n'appelle pas Discord. Un envoi anonyme (relais ouvert) est compté à part
// sous la clé `undefined`, donc plafonné lui aussi.
const MAX_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

export const recentCount = internalQuery({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, { userId }) => {
    const since = Date.now() - HOUR_MS;
    const rows = await ctx.db
      .query("bugReports")
      .withIndex("by_user_created", (q) => q.eq("userId", userId).gt("createdAt", since))
      .collect();
    return { count: rows.length, allowed: rows.length < MAX_PER_HOUR, max: MAX_PER_HOUR };
  },
});

// Écrit APRÈS l'acceptation par Discord : un rapport enregistré ici est un rapport qui est vraiment
// dans le salon, sinon le plafond horaire se remplirait d'envois qui n'ont jamais abouti.
export const record = internalMutation({
  args: {
    reportId: v.string(),
    userId: v.optional(v.string()),
    userName: v.optional(v.string()),
    severity: v.optional(v.string()),
    category: v.optional(v.string()),
    module: v.optional(v.string()),
    appVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("bugReports", { ...args, createdAt: Date.now() });
  },
});
