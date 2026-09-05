// @ts-check
// core/server.js
// Point d'entrée du service Node "core" (headless). La coquille Tauri spawn ce process.
// Un seul serveur HTTP local : média (Range/stream) + RPC (WS/SSE).
// La coquille Tauri spawn ce process et le webview tape sur http://127.0.0.1:NR_CORE_PORT.

// Node imprime `ExperimentalWarning: SQLite…` sur stderr au 1er require('node:sqlite') (avec préfixe
// `(node:PID)`) → capté en ROUGE `[error]` dans le journal alors que c'est bénin (avertissement, pas
// erreur). On l'étouffe À LA SOURCE avant tout chargement de module qui tire node:sqlite. Les vrais
// avertissements passent toujours (process.on('warning') dans logbus les émet en niveau `warn`).
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === "object" && rest[0] ? rest[0].type : rest[0];
  const msg = typeof warning === "string" ? warning : warning && warning.message;
  if (type === "ExperimentalWarning" && /\bSQLite\b/i.test(String(msg))) return;
  return _emitWarning(warning, ...rest);
};

// Purge les dérivés de la session précédente AVANT de charger RPC et ses sidecars. C'est le filet de
// sécurité après crash ; le chemin normal les supprime déjà à la fermeture.
const sessionCache = require("./sessionCache");
sessionCache.resetSync();

const http = require("node:http");
const { Readable } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const { serveFile, streamMedia, mediaGuard } = require("./media-server");
const { flow } = require("./flow");
const logbus = require("./logbus");
const { serveApp } = require("./appstatic");
const { serveYoutube } = require("./ytstream");
const { createRpc } = require("./rpc");
const { killSidecars } = require("./sidecars");
const { killRoto } = require("./roto");
const { ffBin, NR_HOME } = require("./config");
const { getCapabilities } = require("./export/capabilities");
const { refreshYtDlpForAppVersion } = require("./ytdlpUpdate");
const { controlRequestAllowed } = require("./httpSecurity");

const HOST = "127.0.0.1";
// Port IMPOSÉ par la coquille Tauri (elle en choisit un libre et le sert au renderer via
// `nr_core_port`) : il fait autorité, et un conflit se règle par un redémarrage qui en reprendra un
// autre. Lancé seul (`npm run core`), le service balaie lui-même la plage — sinon un port occupé
// laissait l'app sans backend.
const FIXED_PORT = Number(process.env.NR_CORE_PORT) || 0;
const PORT_FIRST = 8730;
const PORT_SPAN = 20;

const rpc = createRpc();

/// Relays one rendered frame from the NetsuFlow service.
///
/// The two alpha headers ride along because a fully transparent composition and
/// a composition that failed to render look identical on screen; the page says
/// which one it is, and it can only say so if the numbers survive the relay.
async function serveFlowFrame(req, res, frame) {
  const index = Number(frame);
  if (!Number.isInteger(index) || index < 0) {
    res.writeHead(400).end("bad frame");
    return;
  }
  const port = flow.editorPort();
  if (!port) {
    res.writeHead(503).end("renderer service is not running");
    return;
  }
  // A handler must never reject: an unhandled rejection here would take the
  // core down for one image request.
  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/api/frame?n=${index}`);
    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.status).end("frame unavailable");
      return;
    }
    const headers = { "Content-Type": upstream.headers.get("content-type") || "image/png" };
    for (const name of ["x-opaque-pixels", "x-partial-alpha-pixels"]) {
      const value = upstream.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    res.writeHead(200, headers);
    // Streamed rather than buffered: a 1080p PNG is megabytes, and holding one
    // per in-flight scrub step in memory is the same mistake twice.
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    logbus.emit("flow", "error", `frame ${index}: ${e && e.message ? e.message : e}`);
    if (res.headersSent) res.destroy();
    else res.writeHead(502).end("renderer service unreachable");
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${HOST}`);

  // RPC/SSE/health accept only the Tauri renderer, a served or dev loopback renderer, or a holder of
  // the shared token (Adobe panel, MCP bridge). CORS `*` was a browser-to-loopback confused-deputy
  // primitive here: a public web page could invoke ffmpeg, open paths, or mutate local state. /media,
  // /stream and /ytstream still carry NO CORS header: they serve arbitrary disk files, and without
  // `Access-Control-Allow-Origin` a third-party site cannot read their content through fetch (the
  // webview's own <img>/<video> tags need no CORS to display them).
  const controlRoute = u.pathname === "/rpc" || u.pathname === "/events";
  // Liveness beacon, and the ONLY way an out-of-process client can find the service: the port moves
  // between launches, so the Adobe panel sweeps the range reading `{ok, app, port, channels}`. It
  // carries nothing worth guarding, and guarding it would lock the panel out before it could prove
  // anything about itself.
  const beaconRoute = u.pathname === "/healthz";

  // A preflight carries no custom header by construction — it announces them, it does not send them
  // — so it cannot authenticate itself, and it performs no action. It is answered ahead of the
  // guard, which then applies to the real request that follows.
  if (req.method === "OPTIONS") {
    if (!controlRoute && !beaconRoute) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ? String(req.headers.origin) : "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-nr-token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.writeHead(204).end();
    return;
  }

  if (controlRoute && !controlRequestAllowed(req.headers, u)) {
    res.writeHead(403).end("forbidden origin");
    return;
  }
  if (controlRoute && req.headers.origin) {
    // The origin is echoed back, never `*`: the response is readable only by the caller already
    // recognised above, and `Vary` stops a cache from serving it to another origin.
    res.setHeader("Access-Control-Allow-Origin", String(req.headers.origin));
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-nr-token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (beaconRoute) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  }

  if (u.pathname === "/healthz") {
    // `app` identifie le service : un client qui balaie la plage de ports doit pouvoir écarter un
    // logiciel tiers qui répondrait 200 sur le même port.
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ok: true, app: "netsurush", port: activePort, channels: rpc.channels.length }));
    return;
  }
  // Renderer buildé sous /app (vue remote du panneau CEP en production, sans Vite).
  if (serveApp(req, res, u)) return;
  if (u.pathname === "/media") {
    if (mediaGuard(req, res, u)) return;
    serveFile(req, res, u.searchParams.get("p"));
    return;
  }
  if (u.pathname === "/stream") {
    if (mediaGuard(req, res, u)) return;
    streamMedia(req, res, {
      p: u.searchParams.get("p"),
      t: parseFloat(u.searchParams.get("t") || "0") || 0,
      mode: u.searchParams.get("mode") === "copy" ? "copy" : "enc",
      ffmpegBin: ffBin("ffmpeg"),
    });
    return;
  }
  // Frame d'une composition NetsuFlow, relayée depuis le service de rendu. Même garde que /media,
  // et pour la même raison : la réponse est affichable par une <img> du webview sans CORS, mais
  // illisible par fetch depuis une page tierce. Relais plutôt qu'accès direct au service — son
  // port change à chaque lancement, et le renderer n'a pas à le connaître pour afficher une image.
  if (u.pathname === "/flow/frame") {
    if (mediaGuard(req, res, u)) return;
    void serveFlowFrame(req, res, u.searchParams.get("n"));
    return;
  }
  // Flux YouTube relayé (lecture sans iframe, cf. core/ytstream.js). Même garde que /media : hôte
  // local + jeton, et pas d'en-tête CORS (une page tierce ne doit pas pouvoir lire la réponse).
  if (u.pathname === "/ytstream") {
    if (mediaGuard(req, res, u)) return;
    void serveYoutube(req, res, u.searchParams.get("id"));
    return;
  }
  if (rpc.handle(req, res, u)) return;

  res.writeHead(404).end("not found");
});

let activePort = FIXED_PORT || PORT_FIRST;

// Le port retenu est publié sur disque : les clients HORS processus (panneau CEP, diagnostic) n'ont
// aucun autre moyen de le connaître, et le renderer Tauri, lui, le tient de la coquille.
// The token ships alongside it: that is what lets the Adobe panel through on /rpc and /events, whose
// `file:` origin is refused. The file is written with the user's own rights — no web page reads it.
function publishPort(port) {
  process.env.NR_CORE_PORT = String(port); // hérité par les sidecars et le serveur MCP
  try {
    fs.mkdirSync(NR_HOME, { recursive: true });
    const token = process.env.NR_CORE_TOKEN || "";
    fs.writeFileSync(path.join(NR_HOME, "core-port.json"), JSON.stringify({ port, pid: process.pid, url: `http://${HOST}:${port}`, token }));
  } catch (error) {
    console.warn("core: port non publié (le panneau Adobe devra le chercher)", String(error));
  }
}

function onListening() {
  activePort = /** @type {any} */ (server.address())?.port || activePort;
  publishPort(activePort);
  console.log(`NetsuRush core: http://${HOST}:${activePort} (${rpc.channels.length} canaux)`);
  // Chauffe la sonde d'encodeurs en arrière-plan : NetsuCut récupère ensuite immédiatement le bon
  // moteur NVENC/AMF/QSV (ou son repli CPU) au premier survol.
  void getCapabilities()
    .then((caps) => console.log(`Encodeurs vidéo: ${caps.hwEncoders.join(', ') || 'CPU'}`))
    .catch((error) => console.warn('Sonde encodeurs indisponible, repli CPU:', String(error)));
  // Refreshes yt-dlp on the first boot of a new application version, and on that boot only. In the
  // background: a version gap downloads a wheel, and no link on a board should wait for that.
  void refreshYtDlpForAppVersion()
    .catch((error) => console.warn('yt-dlp: mise à jour ignorée:', String(error)));
}

server.on("listening", onListening);

server.on("error", (err) => {
  if (/** @type {any} */ (err).code !== "EADDRINUSE") {
    console.error("core server error:", err);
    void shutdown(1);
    return;
  }
  // Port pris : une autre instance de NetsuRush, une session de développement, ou un logiciel tiers.
  // Quand la coquille impose le port, elle est la seule à savoir lequel le renderer interrogera :
  // en changer ici rendrait le service introuvable — elle en choisit un autre au redémarrage.
  if (FIXED_PORT) {
    console.error(`core: port ${FIXED_PORT} déjà utilisé ; l'application en choisira un autre au redémarrage.`);
    void shutdown(1);
    return;
  }
  const next = activePort + 1;
  if (next >= PORT_FIRST + PORT_SPAN) {
    console.error(`core: aucun port libre entre ${PORT_FIRST} et ${PORT_FIRST + PORT_SPAN - 1}.`);
    void shutdown(1);
    return;
  }
  console.warn(`core: port ${activePort} occupé, essai sur ${next}.`);
  activePort = next;
  server.listen(activePort, HOST);
});

server.listen(activePort, HOST);

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { rpc.stopWatch?.(); } catch {}
  try { rpc.stopAgent?.(); } catch {}
  try { rpc.stopDiscord?.(); } catch {} // retire la Rich Presence : sinon elle reste affichée sur le profil
  try { rpc.stopCache?.(); } catch {}
  try { rpc.stopWatchdog?.(); } catch {}
  try { rpc.stopArchiveQueue?.(); } catch {}
  try { rpc.stopPrewarm?.(); } catch {}
  // Referme les projets .netsu ouverts : sans ce repli du journal WAL, un `-wal` reste à côté de
  // chaque fichier et la prochaine ouverture repart d'un journal à rejouer.
  try { rpc.closeProjects?.(); } catch (e) { console.error("netsu: fermeture des projets impossible", e); }
  // Vide les édits de découpe encore en tampon AVANT de tuer quoi que ce soit (écriture disque courte).
  try { rpc.flushCutEdits?.(); } catch (e) { console.error("cut-edits: vidage final impossible", e); }
  try { killSidecars(); } catch {} // tue les daemons python avant de supprimer leurs fichiers de travail
  try { killRoto(); } catch {}
  await sessionCache.cleanup();
  await new Promise((resolve) => {
    try { server.close(resolve); } catch { resolve(); }
  });
  process.exit(code);
}

// La coquille Tauri écrit cette commande dans stdin avant son kill de secours. Contrairement à un
// `Child.kill()` Windows, ce chemin laisse Node arrêter Python et vider le cache de session.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (String(chunk).split(/\r?\n/).some((line) => line.trim() === "shutdown")) void shutdown(0);
});
process.stdin.resume();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void shutdown(0));
}
