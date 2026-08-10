// @ts-check
// core/ytstream.js
// Lecture YouTube SANS le lecteur YouTube. yt-dlp résout l'URL du flux média, le core la relaie sur
// `/ytstream?id=<videoId>`, et le renderer lit ça dans un `<video>` ordinaire. Motif : le lecteur
// intégré repose son habillage (gros bouton lecture, écran de fin) au moindre seek ou pause — c'est
// le clignotement visible à chaque tour de boucle sur le board, et aucun `playerVars` ne le retire.
// Sans iframe, il n'y a plus d'habillage possible, et la boucle/le ping-pong/le trim deviennent ceux
// d'une vidéo locale.
//
// L'URL renvoyée par YouTube expire (quelques heures) : c'est le RELAIS qui la renouvelle sur 403,
// jamais le renderer. Côté board, `/ytstream?id=…` est donc une source stable et persistable.

const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { PYTHON, DETECT_ENV } = require("./config");

// Board muet → un flux VIDÉO SEUL suffit et évite le merge ffmpeg. Repli progressif (piste audio
// incluse) pour les vidéos sans DASH mp4.
const FORMAT = "bv*[ext=mp4][height<=1080]/bv*[height<=1080]/b[ext=mp4]/b";
const RESOLVE_TIMEOUT_MS = 45000;
const UPSTREAM_TIMEOUT_MS = 20000;
// Marge sous la durée de vie réelle de l'URL : on renouvelle avant que googlevideo ne réponde 403.
const CACHE_TTL_MS = 90 * 60 * 1000;
const MAX_REDIRECTS = 3;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Python porteur de yt-dlp : venv local d'abord (dev), sinon l'interpréteur configuré. Même
// résolution que core/extract.js — les deux tapent le même module.
function resolvePython() {
  const venv = process.platform === "win32"
    ? path.join(__dirname, "..", ".venv", "Scripts", "python.exe")
    : path.join(__dirname, "..", ".venv", "bin", "python");
  try { if (fs.existsSync(venv)) return venv; } catch (_) {}
  return PYTHON;
}
const PY = resolvePython();

/** @type {Map<string, { url: string, at: number }>} */
const cache = new Map();
/** @type {Map<string, Promise<{ ok: boolean, url?: string, error?: string }>>} */
const inflight = new Map();

// Un id YouTube est un jeton opaque : tout le reste est refusé avant d'atteindre un spawn.
function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{5,20}$/.test(id);
}

function runYtdlp(id) {
  return new Promise((resolve) => {
    const args = [
      "-m", "yt_dlp", `https://www.youtube.com/watch?v=${id}`,
      "-f", FORMAT,
      "--no-playlist", "--no-warnings", "--no-progress",
      "--socket-timeout", "20",
      "-g",
    ];
    const child = spawn(PY, args, { env: DETECT_ENV });
    let out = "", err = "";
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, RESOLVE_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(killer); resolve({ ok: false, error: String(e) }); });
    child.on("close", (code) => {
      clearTimeout(killer);
      const url = out.split(/\r?\n/).map((s) => s.trim()).find((s) => /^https:\/\//.test(s));
      if (code === 0 && url) resolve({ ok: true, url });
      else resolve({ ok: false, error: err.trim() || `yt-dlp code ${code}` });
    });
  });
}

// Résout (et mémorise) l'URL du flux. `force` ignore le cache : c'est ce que fait le relais quand
// googlevideo a refusé une URL périmée. Les appels concurrents sur le même id partagent un spawn.
async function resolveStream(id, force = false) {
  if (!validId(id)) return { ok: false, error: "bad id" };
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, url: hit.url };
  if (force) cache.delete(id);
  const pending = inflight.get(id);
  if (pending) return pending;
  const job = runYtdlp(id).then((r) => {
    if (r.ok && r.url) cache.set(id, { url: r.url, at: Date.now() });
    inflight.delete(id);
    return r;
  });
  inflight.set(id, job);
  return job;
}

// En-têtes repris de googlevideo : ceux dont un `<video>` a besoin (type, taille, plages), rien de
// plus — pas de cookie ni d'en-tête de suivi renvoyé au webview.
function passHeaders(up) {
  /** @type {Record<string, string>} */
  const h = { "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=600" };
  for (const k of ["content-type", "content-length", "content-range"]) {
    const v = up.headers[k];
    if (typeof v === "string") h[k.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase())] = v;
  }
  return h;
}

function pipeUpstream(url, req, res, onExpired, redirects = 0) {
  /** @type {Record<string, string>} */
  const headers = { "user-agent": UA };
  if (typeof req.headers.range === "string") headers.range = req.headers.range;
  const upReq = https.get(url, { headers }, (up) => {
    const code = up.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(code) && up.headers.location && redirects < MAX_REDIRECTS) {
      up.resume();
      pipeUpstream(String(up.headers.location), req, res, onExpired, redirects + 1);
      return;
    }
    // URL périmée / révoquée → une seule tentative de renouvellement, en amont du renderer.
    if ((code === 403 || code === 410) && onExpired) {
      up.resume();
      onExpired();
      return;
    }
    res.writeHead(code || 502, passHeaders(up));
    up.pipe(res);
  });
  upReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => upReq.destroy(new Error("timeout")));
  upReq.on("error", () => { if (!res.headersSent) res.writeHead(502).end("upstream error"); else res.destroy(); });
  // Item retiré du board / board fermé : on coupe la requête amont au lieu de la laisser couler.
  res.on("close", () => upReq.destroy());
}

function logResolveFailure(id, error) {
  const detail = String(error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 800);
  console.error(`ytstream: resolve ${id} failed: ${detail}`);
}

// GET/HEAD `/ytstream?id=<videoId>` — relaie le flux avec les plages d'octets (seek et trim en
// dépendent). Le renouvellement d'URL est transparent : le renderer ne voit qu'une source stable.
async function serveYoutube(req, res, id) {
  if (!validId(id)) { res.writeHead(400).end("bad id"); return; }
  const first = await resolveStream(id);
  if (!first.ok || !first.url) {
    logResolveFailure(id, first.error);
    res.writeHead(502).end("resolve failed");
    return;
  }
  pipeUpstream(first.url, req, res, async () => {
    const again = await resolveStream(id, true);
    if (!again.ok || !again.url) {
      logResolveFailure(id, again.error);
      if (!res.headersSent) res.writeHead(502).end("resolve failed");
      return;
    }
    pipeUpstream(again.url, req, res, null);
  });
}

module.exports = { serveYoutube, resolveStream };
