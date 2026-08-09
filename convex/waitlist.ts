import { mutation } from "./_generated/server";
import { v } from "convex/values";

// Inscription beta depuis le site web (formulaire public, pas d'auth requise).
// Dédupliqué par email normalisé — re-soumettre le même email est un no-op silencieux
// (pas d'oracle « cet email est déjà inscrit » côté client).
export const join = mutation({
  args: { email: v.string(), source: v.optional(v.string()) },
  handler: async (ctx, { email, source }) => {
    const normalized = email.trim().toLowerCase();
    // Validation minimale — le vrai filtre est la confirmation par email au lancement.
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error("EMAIL_INVALID");
    }
    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", normalized))
      .unique();
    if (existing) return { ok: true as const };
    await ctx.db.insert("waitlist", {
      email: normalized,
      createdAt: Date.now(),
      source,
    });
    return { ok: true as const };
  },
});
