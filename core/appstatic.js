// @ts-check
// core/appstatic.js
// Sert le renderer BUILDÉ (dist/) en HTTP sous /app — la vue « remote » du panneau CEP Adobe
// (iframe) fonctionne ainsi SANS le serveur Vite de dev : le panneau charge http://127.0.0.1:8730/app/
// en production. Racine : NR_RESOURCE_DIR/dist (bundle, stagé par build.ps1) sinon <repo>/dist (dev,
// après `npm run build`). Lecture seule, borné à la racine (aucun path traversal possible).

const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');
const logbus = require('./logbus');

const MIME = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
});

// Racine du renderer buildé, MÉMORISÉE une fois trouvée : le panneau CEP charge l'app entière depuis
// /app (300+ chunks), et re-sonder le disque à chaque requête gelait la boucle d'événements autant de
// fois. Un dist/ ne se déplace pas ; tant qu'il est introuvable on re-sonde, donc la propriété utile
// en dev (dist/ apparaît après le boot) est conservée.
/** @type {string|null} */
let cachedRoot = null;

/** Racine du renderer buildé, ou null si aucun build n'est servable. */
function distRoot() {
  if (cachedRoot) return cachedRoot;
  const candidates = [
    process.env.NR_RESOURCE_DIR ? path.join(process.env.NR_RESOURCE_DIR, 'dist') : null,
    path.join(__dirname, '..', 'dist'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(path.join(c, 'index.html'))) {
        cachedRoot = c;
        return cachedRoot;
      }
    } catch (_) { /* candidat illisible : on tente le suivant */ }
  }
  return null;
}

/** true si un build est servable (le panneau CEP sonde /app/ avant de pointer son iframe dessus). */
function appAvailable() {
  return !!distRoot();
}

/**
 * Sert /app et /app/* depuis dist/. Retourne true si la requête a été traitée.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {URL} u
 */
function serveApp(req, res, u) {
  if (u.pathname !== '/app' && !u.pathname.startsWith('/app/')) return false;
  const root = distRoot();
  if (!root) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: t('rendererMissing') }));
    return true;
  }
  // /app → /app/ (les URLs relatives de index.html doivent se résoudre sous /app/).
  if (u.pathname === '/app') {
    res.writeHead(302, { Location: '/app/' + (u.search || '') }).end();
    return true;
  }
  let rel = decodeURIComponent(u.pathname.slice('/app/'.length));
  if (!rel) rel = 'index.html';
  // Résolution bornée à la racine : normalise puis vérifie le préfixe (bloque ../ et chemins absolus).
  const abs = path.normalize(path.join(root, rel));
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  void sendAsset(req, res, root, abs);
  return true;
}

/**
 * Envoie l'asset (ou index.html en repli SPA). Tout est ASYNCHRONE : le panneau CEP demande des
 * centaines de chunks d'affilée, et chaque syscall synchrone bloquait la boucle d'événements — donc
 * aussi le RPC et le flux SSE que ce même panneau vient d'ouvrir.
 * Ne rejette jamais : un rejet non géré dans un handler HTTP tuerait le core.
 */
async function sendAsset(req, res, root, abs) {
  try {
    // Un seul stat : `isDirectory` et la taille viennent du même appel, l'échec vaut « absent ».
    // SPA : toute route inconnue retombe sur index.html (le renderer route côté client).
    let file = abs;
    let stat = await fs.promises.stat(file).catch(() => null);
    if (!stat || stat.isDirectory()) {
      file = path.join(root, 'index.html');
      stat = await fs.promises.stat(file);
    }
    if (res.writableEnded || res.destroyed) return;
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // index.html jamais caché (déploiement d'un nouveau build = rechargement propre) ; les assets
      // Vite sont fingerprintés → cache long sans risque.
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    logbus.emit('core', 'error', `/app: lecture impossible (${abs}) — ${e && e.message ? e.message : e}`);
    if (res.headersSent) res.destroy();
    else res.writeHead(500).end('read error');
  }
}

module.exports = { serveApp, appAvailable };
