import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Tables de l'app (les tables d'AUTH appartiennent au composant `@convex-dev/better-auth`, isolées).
// P0 minimal : contrôle d'accès beta. De la place pour la sync board / collab plus tard.
export default defineSchema({
  // Droits d'accès par utilisateur (id Better Auth). Beta ouverte = flag OPEN_BETA côté env ;
  // cette table sert la future ALLOWLIST (grant manuel) sans changer le schéma.
  betaGrants: defineTable({
    userId: v.string(), // id du user Better Auth (document._id du composant)
    role: v.string(), // "member" | "admin" | "pending" — accès BETA DESKTOP
    // Rôle sur le SITE : "moderator" | "admin". Absent = membre ordinaire, ce
    // qu'est tout compte connecté (les inscriptions du site sont ouvertes).
    // Champ SÉPARÉ de `role` à dessein : promouvoir un modérateur du site ne
    // doit pas ouvrir la beta desktop, et retirer la beta ne doit pas retirer
    // la modération. Deux droits, deux colonnes.
    siteRole: v.optional(v.string()),
    grantedAt: v.number(),
    note: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  // ——— Tables consommées par le site web (client n°2 du même déploiement) ———

  // Inscriptions « préviens-moi pour la beta » (formulaire public du site).
  waitlist: defineTable({
    email: v.string(), // normalisé lowercase
    createdAt: v.number(),
    source: v.optional(v.string()), // ex. "landing", "download"
  }).index("by_email", ["email"]),

  // Tableau d'idées : propositions de la communauté, votées.
  ideas: defineTable({
    title: v.string(),
    description: v.string(),
    authorId: v.string(), // id user Better Auth
    authorName: v.string(), // dénormalisé (pseudo Discord au moment du post)
    status: v.string(), // "open" | "planned" | "done" | "declined"
    votes: v.number(), // compteur dénormalisé (source de vérité : ideaVotes)
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_votes", ["votes"]),

  // Trace des rapports de bug relayés vers Discord. Le CONTENU reste dans le salon (embed + pièces
  // jointes) : ici seulement de quoi retrouver un rapport et plafonner les envois d'un compte.
  bugReports: defineTable({
    reportId: v.string(), // NR-XXXX, identique au titre de l'embed Discord
    userId: v.optional(v.string()), // id Better Auth quand l'envoi est authentifié
    userName: v.optional(v.string()),
    // Clé du plafond horaire : id du compte, ou empreinte salée de l'IP pour un envoi anonyme
    // (l'IP elle-même n'est jamais écrite).
    quotaKey: v.optional(v.string()),
    severity: v.optional(v.string()),
    category: v.optional(v.string()),
    module: v.optional(v.string()),
    appVersion: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_report", ["reportId"])
    .index("by_quota_created", ["quotaKey", "createdAt"]),

  // Un vote par user et par idée.
  ideaVotes: defineTable({
    ideaId: v.id("ideas"),
    userId: v.string(),
  })
    .index("by_idea_user", ["ideaId", "userId"])
    .index("by_user", ["userId"]),
});
