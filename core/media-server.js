// @ts-check
// core/media-server.js
// Serveur HTTP local : sert les fichiers média au <video>/<img> du webview avec support Range/seek natif.
// Inclut le mode POC Phase 0 (smoke test décodage HEVC dans WebView2).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const logbus = require('./logbus');
const { getCapabilities } = require('./export/capabilities');
const { selectProxyEncoder, proxyVideoArgs, proxyContainerArgs } = require('./proxyEncoder');

const MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  // Documents (aperçu inline dans la WebView2 : PDF a un lecteur natif)
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

// --- Garde anti DNS-rebinding + token optionnel (durcissement /media et /stream) ---------------
// Le core écoute sur 127.0.0.1 mais une page web malveillante peut, via DNS-rebinding, faire
// pointer son propre domaine sur 127.0.0.1 et atteindre ces routes en same-origin (CORS inutile).
// Défense standard : exiger un Host de loopback (bloque le rebinding avant même toute lecture).
// CORS `*` est posé sur /media et /stream (cf. handler) pour le dev cross-origin et le masque Roto ;
// le garde de Host reste la vraie défense, CORS ne l'affaiblit pas.
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// Token partagé : si la coquille Tauri l'injecte (env NR_CORE_TOKEN + global webview), on l'exige en
// plus. Non configuré (dev `npm run core`, ou avant rebuild Tauri) → pas d'enforcement (compat).
const NR_TOKEN = process.env.NR_CORE_TOKEN || "";

function hostAllowed(req) {
  const name = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  return ALLOWED_HOSTS.has(name);
}
function tokenOk(req, u) {
  if (!NR_TOKEN) return true;
  return u.searchParams.get("tk") === NR_TOKEN || req.headers["x-nr-token"] === NR_TOKEN;
}
// true = requête BLOQUÉE (réponse 403 déjà envoyée). À appeler avant serveFile/streamMedia.
function mediaGuard(req, res, u) {
  if (!hostAllowed(req)) { res.writeHead(403).end("forbidden host"); return true; }
  if (!tokenOk(req, u)) { res.writeHead(403).end("forbidden"); return true; }
  return false;
}

// GET/HEAD d'un fichier local avec gestion des requêtes Range (octets).
// Le `stat` est ASYNCHRONE : ce serveur encaisse des rafales (une grille joue jusqu'à ~24 <video>
// qui demandent chacune leurs plages d'octets, la propagation Roto sert une matte par image), et sur
// Windows un stat traverse l'antivirus — en synchrone il gèle la boucle d'événements, donc AUSSI le
// RPC et le flux SSE, derrière chaque requête média.
async function serveFile(req, res, filePath) {
  // Un handler HTTP ne doit JAMAIS rejeter : une promesse rejetée ici tuerait le core (rejet non
  // géré) pour une simple requête média.
  try {
    await respondWithFile(req, res, filePath);
  } catch (e) {
    logbus.emit("core", "error", `media: échec de service de ${filePath} — ${e && e.message ? e.message : e}`);
    if (res.headersSent) res.destroy();
    else res.writeHead(500).end("read error");
  }
}

async function respondWithFile(req, res, filePath) {
  // Null-byte / chemin vide : rejet défensif (jamais un média légitime).
  if (!filePath || String(filePath).includes("\0")) {
    res.writeHead(400).end("bad path");
    return;
  }
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404).end("not a file");
    return;
  }
  // Le client peut avoir coupé pendant le stat (scroll rapide = requêtes annulées en vol).
  if (res.writableEnded || res.destroyed) return;

  const total = stat.size;
  const type = mimeFor(filePath);
  // Cache : proxies/vignettes ont un nom = hash de contenu (immuable) → sans en-tête, le webview
  // re-fetch ET re-décode à CHAQUE re-montage de carte (scroll de grille). ETag (taille+mtime) valide
  // la fraîcheur d'un fichier source écrasé. `private` = données utilisateur locales.
  const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "private, max-age=3600" }).end();
    return;
  }
  const cacheHeaders = {
    "Cache-Control": "private, max-age=3600",
    ETag: etag,
    "Last-Modified": new Date(stat.mtimeMs).toUTCString(),
  };
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
      return;
    }
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
      return;
    }
    res.writeHead(206, {
      ...cacheHeaders,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": type,
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath, { start, end }).on("error", () => res.destroy()).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...cacheHeaders,
    "Content-Length": total,
    "Accept-Ranges": "bytes",
    "Content-Type": type,
    // Rendu inline (PDF/texte/image) plutôt que téléchargement forcé.
    "Content-Disposition": "inline",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
}

// Flux ffmpeg live : transcode/remux à la demande depuis une position.
//  - copy : codec décodable nativement (H.264/HEVC 8-bit) → -c:v copy (démarrage quasi instantané).
//  - enc  : codec exotique/10-bit → transcode 720p via NVENC/QSV/AMF, puis libx264 en repli.
// Le seek = nouvelle requête (le renderer relance le flux) ; on tue ffmpeg quand le client coupe.
async function streamMedia(req, res, { p, t = 0, mode = "enc", ffmpegBin = "ffmpeg" }) {
  if (!p) {
    res.writeHead(400).end("missing p");
    return;
  }
  const args = ["-hide_banner", "-loglevel", "error"];
  if (t > 0) args.push("-ss", String(t));
  args.push("-i", p);
  if (mode === "copy") {
    args.push("-c:v", "copy", "-c:a", "aac", "-b:a", "160k");
  } else {
    let caps;
    try { caps = await getCapabilities(); } catch (_) { caps = {}; }
    const resolved = selectProxyEncoder("hevc", caps);
    args.push("-vf", "scale=-2:720", ...proxyVideoArgs(resolved), ...proxyContainerArgs(resolved),
      "-c:a", "aac", "-b:a", "128k");
  }
  args.push("-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");

  const ff = spawn(ffmpegBin, args);
  ff.stderr.resume(); // draine stderr (sinon le pipe peut bloquer)
  const kill = () => {
    try {
      ff.kill("SIGKILL");
    } catch {}
  };
  req.on("close", kill); // client coupe / seek → tue l'encode
  ff.on("error", kill);
  ff.stdout.on("error", () => {}); // EPIPE quand le client coupe le flux
  res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
  ff.stdout.pipe(res);
}

// Page de test Phase 0 : décode l'asset HEVC dans le webview et auto-rapporte le verdict.
function pocPage(mediaUrl) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>POC HEVC</title>
<style>html,body{margin:0;background:#0a0a0b;color:#eee;font:14px system-ui}
#log{padding:12px;white-space:pre-wrap}video{max-width:100%;display:block}</style></head>
<body><div id="log">POC HEVC WebView2 — chargement…</div>
<video id="v" autoplay muted playsinline src="${mediaUrl}"></video>
<script>
const log=document.getElementById("log"), v=document.getElementById("v");
const can=v.canPlayType('video/mp4;codecs="hvc1.1.6.L93.B0"');
let done=false;
function report(o){if(done)return;done=true;o.canPlayType=can;
  log.textContent="VERDICT "+JSON.stringify(o,null,2);
  fetch("/poc-report",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(o)}).catch(()=>{});}
v.addEventListener("loadeddata",()=>report({ok:v.videoWidth>0,w:v.videoWidth,h:v.videoHeight}));
v.addEventListener("error",()=>report({ok:false,code:v.error&&v.error.code,message:v.error&&v.error.message}));
setTimeout(()=>report({ok:false,reason:"timeout 8s — aucun loadeddata/error"}),8000);
</script></body></html>`;
}

// Crée le serveur. `poc` = { video } active la route /poc + résout onReport au 1er verdict.
function createMediaServer({ host = "127.0.0.1", port = 0, poc = null, ffmpegBin = "ffmpeg" } = {}) {
  let resolveReport;
  const reported = new Promise((r) => (resolveReport = r));

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${host}`);

    // CORS : en dev le renderer (:1420) et le média (:8730) sont cross-origin. Le masque du Roto
    // (`mask-image` CSS cross-origin) EXIGE ces en-têtes ; on les pose sur TOUTES les réponses
    // (y compris 404/416) pour des erreurs propres côté navigateur. Le garde de Host loopback
    // (ALLOWED_HOSTS) bloque déjà le DNS-rebinding — `*` ne l'affaiblit pas (aucun cookie en jeu).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range, If-None-Match, X-NR-Token");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, ETag");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    if (u.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }

    // Stream média : /media?p=<chemin absolu encodé>
    if (u.pathname === "/media") {
      const p = u.searchParams.get("p");
      if (!p) {
        res.writeHead(400).end("missing p");
        return;
      }
      serveFile(req, res, p);
      return;
    }

    // Flux live : /stream?p=&t=&mode=copy|enc
    if (u.pathname === "/stream") {
      void streamMedia(req, res, {
        p: u.searchParams.get("p"),
        t: parseFloat(u.searchParams.get("t") || "0") || 0,
        mode: u.searchParams.get("mode") === "copy" ? "copy" : "enc",
        ffmpegBin,
      }).catch((e) => {
        if (!res.headersSent) res.writeHead(500).end(String(e));
        else res.destroy();
      });
      return;
    }

    // --- POC Phase 0 ---
    if (poc && u.pathname === "/poc") {
      const mediaUrl = `/media?p=${encodeURIComponent(poc.video)}`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(pocPage(mediaUrl));
      return;
    }
    if (poc && u.pathname === "/poc-report" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let json = {};
        try {
          json = JSON.parse(body);
        } catch {}
        res.writeHead(200).end("ok");
        resolveReport(json);
      });
      return;
    }

    res.writeHead(404).end("not found");
  });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actual = /** @type {import('net').AddressInfo} */ (server.address()).port;
      resolve({ host, port: actual, base: `http://${host}:${actual}`, server, reported });
    });
  });

  return ready;
}

module.exports = { createMediaServer, serveFile, streamMedia, mimeFor, mediaGuard };
