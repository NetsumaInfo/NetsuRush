import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// Personne ne doit pouvoir noyer le salon : au-delà de ce nombre de rapports par heure pour une même
// clé, le relais répond 429 et n'appelle pas Discord. La clé est l'id du compte quand l'envoi est
// authentifié, sinon l'empreinte de l'IP — un envoi anonyme est donc plafonné lui aussi, sans que
// tous les anonymes se partagent le même compteur.
const MAX_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

export const recentCount = internalQuery({
  args: { quotaKey: v.optional(v.string()) },
  handler: async (ctx, { quotaKey }) => {
    const since = Date.now() - HOUR_MS;
    const rows = await ctx.db
      .query("bugReports")
      .withIndex("by_quota_created", (q) => q.eq("quotaKey", quotaKey).gt("createdAt", since))
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
    quotaKey: v.optional(v.string()),
    severity: v.optional(v.string()),
    category: v.optional(v.string()),
    module: v.optional(v.string()),
    appVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("bugReports", { ...args, createdAt: Date.now() });
  },
});
