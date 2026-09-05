import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth";
import { components } from "./_generated/api";
import { query } from "./_generated/server";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

// URL publique du site Convex (*.convex.site) — base des routes Better Auth.
const siteUrl = process.env.SITE_URL as string;

// Client du composant : expose l'adapter DB + les helpers (getAuthUser, registerRoutes…).
export const authComponent = createClient<DataModel>(components.betterAuth);

// Instance Better Auth reconstruite par requête (les fonctions Convex n'ont pas de headers).
export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    // Origines de confiance (CSRF + CORS des routes) : site Convex + scheme desktop (retour
    // deep-link) + origines de la webview Tauri (dev Vite localhost:1420, prod tauri.localhost).
    trustedOrigins: [
      siteUrl,
      "netsurush://",
      "http://localhost:1420",
      "http://tauri.localhost",
      "https://tauri.localhost",
      // Site web (client n°2) : dev Vite + prod via env
      // (WEB_ORIGIN à définir sur le déploiement quand l'hébergement sera tranché).
      "http://localhost:3000",
      "http://localhost:5181", // NetsuMerge/apps/web
      ...(process.env.WEB_ORIGIN ? [process.env.WEB_ORIGIN] : []),
    ],
    // Discord et Google. Secrets côté déploiement Convex, jamais dans un bundle.
    // Google est requis par le site : le public des ressources n'est pas celui
    // du salon Discord, et imposer Discord pour télécharger un LUT ferme la
    // porte à la moitié des visiteurs (02-community-access-and-moderation.md).
    // Un fournisseur dont les identifiants ne sont pas définis n'est pas monté :
    // mieux vaut un bouton absent qu'un bouton qui échoue au retour d'OAuth.
    socialProviders: {
      ...(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
        ? {
            discord: {
              clientId: process.env.DISCORD_CLIENT_ID,
              clientSecret: process.env.DISCORD_CLIENT_SECRET,
              // Écran d'autorisation explicite (sinon `prompt=none` échoue au 1er login, user non encore autorisé).
              prompt: "consent" as const,
            },
          }
        : {}),
      ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              // `select_account` : sur un poste partagé, le compte précédent ne
              // doit pas être repris en silence.
              prompt: "select_account" as const,
            },
          }
        : {}),
    },
    // Session gardée 7 jours, rafraîchie chaque jour d'usage en ligne (cf. grâce offline renderer).
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    // Anti-bruteforce intégré (durcissement beta).
    rateLimit: { enabled: true },
    plugins: [
      // crossDomain : le retour OAuth transporte le jeton hors cookie (webview desktop ≠ domaine Convex).
      crossDomain({ siteUrl }),
      // convex : émet le JWT que Convex valide (issuer = auth.config.ts).
      convex({ authConfig }),
    ],
  });

// Utilisateur courant (safe = undefined si non connecté) — pour l'identité UI (avatar/pseudo Discord).
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => authComponent.safeGetAuthUser(ctx),
});
