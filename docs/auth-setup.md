# Auth NetsuRush — Convex + Better Auth + Discord (setup)

Le **code** de l'auth est déjà en place. Restent ces étapes **une seule fois** (elles exigent tes
comptes — je ne peux pas les faire à ta place). Tant qu'elles ne sont pas faites, l'app démarre
normalement (le gate de connexion est inactif : `VITE_CONVEX_URL` absent → `LoginGate` rend l'app
directement, aucun changement).

Architecture : l'auth vit **dans Convex** (`@convex-dev/better-auth`). Le **secret Discord ne touche
jamais l'app** — il vit dans l'env du déploiement Convex. Le desktop ouvre juste le navigateur puis
reçoit la session via le deep-link `netsurush://`.

---

## 1. Déploiement Convex

```bash
npx convex dev
```

- Se connecte (crée un compte au besoin) et provisionne un déploiement dev.
- Écrit `CONVEX_DEPLOYMENT` + `VITE_CONVEX_URL` dans `.env.local`, génère `convex/_generated/`.
- Laisse-le tourner : il pousse `convex/*.ts` (auth, http, schema, access) et regénère les types.

Récupère l'URL **site** (routes Better Auth) : dashboard Convex → Settings → **URL … .convex.site**
(en général = l'URL cloud avec `.cloud` remplacé par `.site`).

## 2. App Discord (Developer Portal)

<https://discord.com/developers/applications> → **New Application** « NetsuRush » → onglet **OAuth2** :

- Copie **Client ID** + **Client Secret**.
- **Redirects** → ajoute exactement :
  `https://<ton-deploiement>.convex.site/api/auth/callback/discord`

## 3. Secrets côté Convex (jamais dans l'app)

```bash
npx convex env set SITE_URL "https://<ton-deploiement>.convex.site"
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
npx convex env set DISCORD_CLIENT_ID "<client id>"
npx convex env set DISCORD_CLIENT_SECRET "<client secret>"
npx convex env set BREVO_API_KEY "<Brevo API key>"   # or RESEND_API_KEY with a verified domain
npx convex env set AUTH_EMAIL_FROM "NetsuRush <login@your-domain>"
npx convex env set OPEN_BETA "true"   # beta ouverte : tout compte connecté a l'accès
npx convex env set BUG_WEBHOOK "<url du webhook Discord>"   # relais des rapports de bug
```

> Le webhook ne descend sur aucune machine : l'app POSTe sur `/bug/report` et le déploiement
> forwarde. Changer de salon = relancer cette commande, sans rebuild ni mise à jour des testeurs.
> Le relais n'exige aucune connexion : un testeur déconnecté peut envoyer un rapport. `npx convex env
> set BUG_QUOTA_SALT "<chaîne aléatoire>"` sale l'empreinte d'IP qui sert de clé de plafond aux
> envois anonymes (facultatif).

> E-mail sign-in: a 6-digit code (10 min, 5 attempts) sent through Brevo's HTTP API when
> `BREVO_API_KEY` is set (one verified sender address, no domain needed), else through Resend
> (`RESEND_API_KEY`, needs a verified domain). `AUTH_EMAIL_FROM` is the sender, `Name <address>`,
> verified on the provider. Without both a key and a sender, e-mail sign-in is refused and Discord
> keeps working. In Brevo, turn **off** "block unauthorised IP addresses" for API keys: Convex sends
> from changing IPs. A Discord or Google login and an e-mail login with the same verified address
> are one account. Sessions last 30 days, and the app stays usable offline for 30 days after the
> last login.

> Bascule en **allowlist** plus tard : `npx convex env set OPEN_BETA false`, puis accorde l'accès
> par utilisateur : `npx convex run access:grantAccess '{"userId":"<id>","role":"member"}'`.

## 4. Fichier `.env.local` (renderer)

```dotenv
VITE_CONVEX_URL=https://<ton-deploiement>.convex.cloud
VITE_CONVEX_SITE_URL=https://<ton-deploiement>.convex.site
```

(`CONVEX_DEPLOYMENT` y est déjà écrit par `npx convex dev`.)

## 5. Lancer

- `npx convex dev` dans un terminal (backend).
- `npm run dev` (Vite) + **redémarre** `npm run tauri dev` (les plugins Rust deep-link/single-instance
  sont nouveaux → recompilation de la coquille requise).

---

## Test runtime

1. Au 1er lancement : écran **« Se connecter avec Discord »** (gate dur).
2. Clic → le navigateur système s'ouvre sur Discord → autorise.
3. Discord → callback Convex → retour `netsurush://auth?ott=…` capté par l'app → session établie →
   le Shell s'affiche (avatar/pseudo Discord dispo via `api.auth.getCurrentUser`).
4. **Grâce offline** : coupe le réseau et relance → l'app passe (login < 7 j). Simule > 7 j en
   modifiant `localStorage["nr.auth.lastAuthAt"]` → l'écran de connexion réapparaît.

## Dépannage

- **Le deep-link ne revient pas (Windows dev)** : le scheme est enregistré au runtime
  (`register_all()` dans `lib.rs`) ; assure-toi d'avoir **redémarré** `npm run tauri dev`. Une seule
  instance de l'app doit tourner (plugin single-instance).
- **`getAccess`/`getCurrentUser` introuvables** : `convex/_generated` pas encore généré → laisse
  `npx convex dev` tourner. Le renderer utilise `anyApi` (référence par chemin), donc `npm run build`
  reste vert même avant.
- **Repli si le custom scheme coince** : basculer sur un callback loopback `http://127.0.0.1:<port>`
  (plugin `tauri-plugin-oauth`) — même échange `ott`, seul le transport du retour change.
