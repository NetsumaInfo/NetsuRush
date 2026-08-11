import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { authComponent, createAuth } from "./auth";

// Monte les routes Better Auth (`/api/auth/*`) : sign-in social, callbacks OAuth, session…
// cors:true → handlers OPTIONS préflight + en-têtes CORS. Requis : la webview desktop
// (origine localhost:1420 en dev, tauri.localhost en prod) attaque le site Convex en cross-origin
// avec un en-tête custom `Better-Auth-Cookie` → sans préflight le POST échoue (net::ERR_FAILED).
const http = httpRouter();
authComponent.registerRoutes(http, createAuth, { cors: true });

// Page de fin OAuth. Le login redirige ICI (HTTPS) au lieu du scheme `netsurush://` direct :
// le navigateur affiche une vraie page (fini le « charge à l'infini »), qui relance l'app via le
// deep-link puis invite à fermer l'onglet. Le `?ott=<jeton>` ajouté par crossDomain est transmis tel
// quel au scheme.
http.route({
  path: "/auth/done",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const search = new URL(req.url).search; // ex. ?ott=abc
    const deepLink = `netsurush://auth${search}`;
    const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NetsuRush — connexion</title>
<style>
  :root { color-scheme: dark; }
  html,body { height:100%; margin:0; }
  body { display:flex; align-items:center; justify-content:center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background:#0b0b0e; color:#e7e7ea; }
  .card { width:min(90vw,360px); padding:2rem; text-align:center;
    background:#141419; border:1px solid #26262e; border-radius:16px; }
  .badge { width:52px; height:52px; margin:0 auto 1rem; border-radius:14px;
    display:flex; align-items:center; justify-content:center;
    background:#5865F2; color:#fff; font-size:26px; }
  h1 { font-size:1.05rem; margin:0 0 .4rem; }
  p { font-size:.85rem; color:#a1a1aa; margin:0 0 1.25rem; line-height:1.5; }
  a { display:inline-block; padding:.55rem 1rem; border-radius:10px;
    background:#5865F2; color:#fff; text-decoration:none; font-size:.85rem; font-weight:600; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">&#10003;</div>
    <h1>Connexion r&eacute;ussie</h1>
    <p>Tu peux fermer cet onglet et revenir dans NetsuRush.</p>
    <a href="${deepLink}">Rouvrir NetsuRush</a>
  </div>
  <script>location.replace(${JSON.stringify(deepLink)});</script>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }),
});

// Relais des rapports de bug. L'application n'a JAMAIS l'URL du webhook Discord : elle POSTe ici, et
// `BUG_WEBHOOK` (variable d'env du déploiement) reste côté serveur — la faire tourner ne demande donc
// ni build ni mise à jour chez les testeurs. Le corps est retransmis TEL QUEL (multipart embed +
// pièces jointes construit par le core) : rien à re-parser, rien à re-plafonner ici.
// Session : le desktop n'a pas de cookies (webview hors domaine Convex), il envoie l'en-tête
// `Better-Auth-Cookie` du plugin crossDomain, que `getSession` sait lire. Elle est FACULTATIVE : un
// bug doit pouvoir remonter même déconnecté (c'est souvent la connexion elle-même qui casse). Sans
// compte, le plafond horaire retombe sur l'IP appelante, qui sert de clé de quota et n'est PAS
// enregistrée avec le rapport.
// Clé de plafond d'un envoi anonyme : empreinte SALÉE de l'IP appelante. Salée et tronquée parce que
// le but est de compter, pas d'identifier — l'IP brute ne doit ni transiter en base ni être
// reconstructible depuis elle. Sans en-tête d'IP, tous les anonymes partagent un même compteur.
async function anonQuotaKey(req: Request): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  const salt = process.env.BUG_QUOTA_SALT ?? process.env.BETTER_AUTH_SECRET ?? "netsurush";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  const hex = Array.from(new Uint8Array(digest.slice(0, 8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ip:${hex}`;
}

http.route({
  path: "/bug/report",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const webhook = process.env.BUG_WEBHOOK;
    if (!webhook) return new Response("relay disabled", { status: 503 });

    const session = await createAuth(ctx)
      .api.getSession({ headers: req.headers })
      .catch(() => null);
    const userId = session?.user?.id;
    const quotaKey = userId ?? (await anonQuotaKey(req));

    const quota = await ctx.runQuery(internal.bugs.recentCount, { quotaKey });
    if (!quota.allowed) return new Response("rate limited", { status: 429 });

    const contentType = req.headers.get("content-type");
    const discord = await fetch(webhook, {
      method: "POST",
      headers: contentType ? { "content-type": contentType } : {},
      body: await req.arrayBuffer(),
    });
    if (!discord.ok) {
      const detail = await discord.text().catch(() => "");
      return new Response(`discord ${discord.status} ${detail.slice(0, 200)}`, { status: 502 });
    }

    // Métadonnées en EN-TÊTES : le corps est un multipart opaque qu'on ne veut pas ouvrir ici.
    const meta = (name: string) => req.headers.get(name) ?? undefined;
    await ctx.runMutation(internal.bugs.record, {
      reportId: meta("x-nr-report-id") ?? "NR-?",
      userId,
      userName: session?.user?.name,
      quotaKey,
      severity: meta("x-nr-severity"),
      category: meta("x-nr-category"),
      module: meta("x-nr-module"),
      appVersion: meta("x-nr-app-version"),
    });
    return new Response(null, { status: 204 });
  }),
});

export default http;
