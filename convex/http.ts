import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
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

export default http;
