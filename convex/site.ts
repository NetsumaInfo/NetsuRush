import { query, mutation, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { authComponent } from "./auth";

// Surface consommée par le SITE web (NetsuMerge/apps/web), client n°2 du même
// déploiement. Une API, deux clients : le compte, le rôle et les données sont
// les mêmes que dans l'application desktop, et cette identité partagée est la
// raison d'être du déploiement unique.
//
// Deux droits distincts vivent dans `betaGrants` :
//   - `role`     → accès BETA DESKTOP ("pending" | "member" | "admin"), lu par access.ts ;
//   - `siteRole` → rôle sur le SITE ("moderator" | "admin"), lu ici seulement.
// Les toucher séparément est volontaire : un modérateur du forum n'a pas à
// recevoir la beta desktop, et couper la beta ne doit pas ouvrir les files de
// modération à personne.

const SITE_ROLES = ["member", "moderator", "admin"] as const;
type SiteRole = (typeof SITE_ROLES)[number];

function asSiteRole(value: string | undefined): SiteRole | null {
  return value !== undefined && (SITE_ROLES as readonly string[]).includes(value)
    ? (value as SiteRole)
    : null;
}

// Amorçage. Sans ça, personne ne peut accorder le PREMIER rôle d'administrateur :
// la console du site est réservée aux admins, et il n'y en a aucun au départ.
// `SITE_ADMIN_IDS` (ids Better Auth séparés par des virgules) est une variable
// d'environnement du déploiement — donc modifiable sans redéployer le site, et
// jamais présente dans un bundle client.
function bootstrapAdmins(): Set<string> {
  return new Set(
    (process.env.SITE_ADMIN_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

async function siteRoleOf(ctx: QueryCtx, userId: string): Promise<SiteRole> {
  if (bootstrapAdmins().has(userId)) return "admin";
  const grant = await ctx.db
    .query("betaGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  // Un rôle inconnu en base ne donne aucun droit : on refuse par défaut.
  return asSiteRole(grant?.siteRole) ?? "member";
}

// Session courante, telle que le site l'affiche. Lisible sans compte : un
// visiteur reçoit `authenticated: false`, jamais une erreur — la moitié
// publique du site n'a pas besoin d'un compte.
export const getSession = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return {
        authenticated: false,
        userId: null,
        name: null,
        image: null,
        role: null,
      };
    }

    return {
      authenticated: true,
      userId: user._id,
      name: user.name ?? null,
      image: user.image ?? null,
      role: await siteRoleOf(ctx, user._id),
    };
  },
});

// Rôles attribués. Les membres n'y figurent pas : être membre est l'état par
// défaut de tout compte connecté, pas une attribution.
export const listGrants = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx); // throw si non connecté
    if ((await siteRoleOf(ctx, user._id)) !== "admin") throw new Error("FORBIDDEN");

    const grants = await ctx.db.query("betaGrants").collect();
    return grants
      .flatMap((grant) => {
        const role = asSiteRole(grant.siteRole);
        if (role === null || role === "member") return [];
        return [
          {
            userId: grant.userId,
            role,
            grantedAt: grant.grantedAt,
            note: grant.note ?? null,
          },
        ];
      })
      .sort((a, b) => b.grantedAt - a.grantedAt);
  },
});

// Attribution d'un rôle de site. Réservée aux administrateurs, vérifié ICI :
// l'interface qui cache la page ne protège rien.
export const setRole = mutation({
  args: {
    userId: v.string(),
    role: v.union(v.literal("member"), v.literal("moderator"), v.literal("admin")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { userId, role, note }) => {
    const actor = await authComponent.getAuthUser(ctx);
    if ((await siteRoleOf(ctx, actor._id)) !== "admin") throw new Error("FORBIDDEN");

    const target = userId.trim();
    if (target.length === 0 || target.length > 128) throw new Error("USER_ID");

    // Se retirer son propre rôle fermerait la porte de l'intérieur : plus
    // aucun administrateur ne pourrait rouvrir la console.
    if (target === actor._id && role !== "admin") throw new Error("SELF_DEMOTE");

    const existing = await ctx.db
      .query("betaGrants")
      .withIndex("by_user", (q) => q.eq("userId", target))
      .unique();

    if (existing) {
      // `role` (beta desktop) n'est PAS touché : ce sont deux droits séparés.
      await ctx.db.patch(existing._id, {
        siteRole: role,
        grantedAt: Date.now(),
        ...(note === undefined ? {} : { note }),
      });
      return null;
    }

    await ctx.db.insert("betaGrants", {
      userId: target,
      // Aucun accès beta desktop accordé au passage : rester "pending" est le
      // défaut, et il se change depuis access:grantAccess, pas depuis le site.
      role: "pending",
      siteRole: role,
      grantedAt: Date.now(),
      ...(note === undefined ? {} : { note }),
    });
    return null;
  },
});
