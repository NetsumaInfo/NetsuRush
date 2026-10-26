import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
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
    // A login by any of these providers and an e-mail login with the same verified address are one account.
    account: { accountLinking: { enabled: true, trustedProviders: ["discord", "google", "email-otp"] } },
    // Session kept 30 days, refreshed on each day of online use (see the renderer's offline grace).
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    // Anti-bruteforce intégré (durcissement beta).
    rateLimit: { enabled: true },
    plugins: [
      // crossDomain : le retour OAuth transporte le jeton hors cookie (webview desktop ≠ domaine Convex).
      crossDomain({ siteUrl }),
      // convex : émet le JWT que Convex valide (issuer = auth.config.ts).
      convex({ authConfig }),
      // Sign-in by a code sent to the address: no password to store or reset. The first code creates
      // the account.
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") return;
          await sendSignInCode(email, otp);
        },
      }),
    ],
  });

// Sent through the provider's HTTP API, no SDK in the bundle. Brevo (BREVO_API_KEY) takes a single
// verified sender address, so it works without a domain; Resend (RESEND_API_KEY) needs a verified
// domain. AUTH_EMAIL_FROM is the sender, `Name <address>`. Keys live on the deployment.
async function sendSignInCode(email: string, otp: string) {
  const from = process.env.AUTH_EMAIL_FROM;
  if (!from) throw new Error("e-mail sign-in is not configured");
  const subject = "Your NetsuRush sign-in code";
  const text = `Your NetsuRush sign-in code: ${otp}

It expires in 10 minutes. If you did not ask for it, ignore this e-mail.`;

  const brevo = process.env.BREVO_API_KEY;
  if (brevo) {
    const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
    const sender = match ? { name: match[1] || "NetsuRush", email: match[2] } : { email: from.trim() };
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": brevo, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sender, to: [{ email }], subject, textContent: text }),
    });
    if (!res.ok) throw new Error(`Brevo refused the e-mail (${res.status}): ${(await res.text()).slice(0, 300)}`);
    console.log(`sign-in code accepted by Brevo: ${(await res.text()).slice(0, 120)}`);
    return;
  }

  const resend = process.env.RESEND_API_KEY;
  if (!resend) throw new Error("e-mail sign-in is not configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject, text }),
  });
  if (!res.ok) throw new Error(`Resend refused the e-mail (${res.status})`);
}

// Utilisateur courant (safe = undefined si non connecté) — pour l'identité UI (avatar/pseudo Discord).
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => authComponent.safeGetAuthUser(ctx),
});
