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
//
// Le relais BORNE lui-même chaque requête amont. Une URL googlevideo signée refuse (403) les
// requêtes sans borne de fin dès qu'elle a un peu servi — or c'est exactement ce qu'un `<video>`
// envoie pour ouvrir un flux (`Range: bytes=0-`, ou aucun en-tête du tout). Le relais découpe donc
// la lecture en tranches et les recolle : côté webview `/ytstream` reste un fichier ordinaire servi
// en Range, et c'est aussi ainsi que le lecteur de YouTube consomme ces URL.

const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { PYTHON, DETECT_ENV, cookieBrowserCandidates, ytCookiesFile, jsRuntimeArgs } = require("./config");

// Board muet → un flux VIDÉO SEUL suffit et évite le merge ffmpeg. Repli progressif (piste audio
// incluse) pour les vidéos sans DASH mp4.
//
// Deux filtres portent cette sélection, et sans eux le `<video>` reste noir :
//   `protocol^=https` écarte les formats servis en HLS — le « Premium 1080p » (itag 616) n'existe
//   qu'en m3u8, `-g` rend alors un MANIFESTE, que WebView2 ne sait pas lire (pas de HLS natif).
//   `vcodec^=avc1` d'abord : le même 1080p existe en VP9 et en AV1, décodés en logiciel dans la
//   WebView — un board qui joue dix vidéos à la fois ne les tient pas.
const FORMAT = [
  "bv*[protocol^=https][vcodec^=avc1][height<=1080]",
  "bv*[protocol^=https][ext=mp4][height<=1080]",
  "bv*[protocol^=https][height<=1080]",
  "b[protocol^=https][ext=mp4]",
  "b[protocol^=https]",
].join("/");
const RESOLVE_TIMEOUT_MS = 45000;
const UPSTREAM_TIMEOUT_MS = 20000;
// Marge sous la durée de vie réelle de l'URL : on renouvelle avant que googlevideo ne réponde 403.
const CACHE_TTL_MS = 90 * 60 * 1000;
const MAX_REDIRECTS = 3;
// Taille d'une tranche amont. Assez grande pour que la lecture ne soit pas une rafale de requêtes,
// assez petite pour rester dans ce que googlevideo sert sans broncher.
const CHUNK = 2 * 1024 * 1024;
// Une URL refusée en COURS de lecture est renouvelée en vol. Une seule tentative laissait la vidéo
// morte jusqu'au prochain montage de l'item.
const MAX_RENEWALS = 3;
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

// YouTube refuses a growing share of videos to a client with no session ("Sign in to confirm you're
// not a bot"). The check is not on the video but on the CALLER: the same URL goes through with the
// cookies of a browser where the user is signed in. They are NEVER sent up front - public content
// works without them, and reading a browser keyring on every playback would be indefensible - only
// on a second pass, when the failure carries that signature. Same strategy as core/extract.js, same
// `cookiesBrowser` setting in nr.config.json.
const BOT_CHECK = /sign in to confirm|not a bot|confirm your age|login required|use --cookies|429|too many requests/i;

/** Is this failure worth a second attempt WITH cookies? Exported: it is the rule that decides
 * whether a browser keyring gets read, and it must not drift unnoticed.
 * @param {string} error @returns {boolean} */
function needsCookies(error) {
  return BOT_CHECK.test(String(error || ""));
}

function runYtdlp(id, cookiesBrowser, cookiesFile) {
  return new Promise((resolve) => {
    const args = [
      "-m", "yt_dlp", `https://www.youtube.com/watch?v=${id}`,
      "-f", FORMAT,
      "--no-playlist", "--no-warnings", "--no-progress",
      "--socket-timeout", "20",
      "-g",
      ...jsRuntimeArgs(),
    ];
    if (cookiesFile) args.push("--cookies", cookiesFile);
    else if (cookiesBrowser) args.push("--cookies-from-browser", cookiesBrowser);
    const child = spawn(PY, args, { env: DETECT_ENV });
    let out = "", err = "";
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, RESOLVE_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    // ENOENT = the tool is absent, not an invalid link. The raw message ("spawn python ENOENT")
    // named neither what is missing nor how to put it there: the user saw an empty player and a log
    // line they could not read, for a dependency the setup announces as optional.
    child.on("error", (e) => {
      clearTimeout(killer);
      const missing = /** @type {NodeJS.ErrnoException} */ (e)?.code === "ENOENT";
      resolve({
        ok: false,
        error: missing ? `yt-dlp introuvable (${PY}) - relance l'installation pour poser l'outil` : String(e),
        missingTool: missing || undefined,
      });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      // Un manifeste (HLS/DASH) qui passerait malgré le filtre de protocole vaut un échec : mieux
      // vaut le repli sur le lecteur intégré qu'un `<video>` muré sur une source illisible.
      const url = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => /^https:\/\//.test(s) && !/\.m3u8|\/manifest\//i.test(s));
      if (code === 0 && url) resolve({ ok: true, url });
      else resolve({ ok: false, error: err.trim() || `yt-dlp code ${code}` });
    });
  });
}

// Public pass, then a cookie pass ONLY on an anti-bot style refusal. An ordinary failure (private,
// deleted or geoblocked video) does not trigger a keyring read: it would change nothing and would
// cost a second attempt on every broken playback.
//
// "You must be signed in" already met for this video. The fallback chain costs one yt-dlp launch PER
// candidate (a few seconds each); without this memory, every remount of the item paid the whole
// chain again to hit the same wall. The entry expires: a session opened meanwhile must get a turn.
/** @type {Map<string, number>} */
const authWall = new Map();
const AUTH_WALL_TTL_MS = 10 * 60 * 1000;

async function resolveWithFallback(id) {
  const first = await runYtdlp(id, null, null);
  if (first.ok || first.missingTool) return first;
  if (!needsCookies(first.error)) return first;

  const walled = authWall.get(id);
  if (walled && Date.now() - walled < AUTH_WALL_TTL_MS) return { ok: false, error: authAdvice([]), authWall: true };

  // A session, not a specific browser: a cookies.txt file first (exported once, readable even with
  // the browser open), then the installed browsers. None is REQUIRED - with no usable session the
  // board falls back to its embedded player and the video stays watchable.
  const cookiesFile = ytCookiesFile();
  const attempts = [
    ...(cookiesFile ? [{ label: "cookies.txt", run: () => runYtdlp(id, null, cookiesFile) }] : []),
    ...cookieBrowserCandidates().map((browser) => ({ label: browser, run: () => runYtdlp(id, browser, null) })),
  ];
  const tried = [];
  for (const attempt of attempts) {
    const retry = await attempt.run();
    if (retry.ok) return retry;
    tried.push(`${attempt.label} : ${firstLine(retry.error)}`);
  }
  authWall.set(id, Date.now());
  return { ok: false, error: authAdvice(tried), authWall: true };
}

// Two very different failures look alike in the log, and the thing to do is not the same: a LOCKED
// browser (Chrome/Edge keep a hold on their cookie database while open, yt-dlp#7271) is not a
// browser WITHOUT A SESSION. Saying which one happened saves closing a browser that had no signed-in
// account in the first place.
const LOCKED = /could not copy .*cookie database/i;

function authAdvice(tried) {
  const head = "YouTube réserve cette vidéo aux comptes connectés - le board bascule sur son lecteur pour celle-ci. ";
  if (!tried.length) {
    return `${head}Aucune source de session configurée : connecte-toi à YouTube dans Firefox, ou renseigne « cookiesFile » `
      + "(cookies.txt exporté) dans nr.config.json.";
  }
  const locked = tried.filter((line) => LOCKED.test(line)).map((line) => line.split(" : ")[0]);
  const noSession = tried.filter((line) => !LOCKED.test(line)).map((line) => line.split(" : ")[0]);
  const parts = [];
  if (locked.length) {
    const many = locked.length > 1;
    parts.push(`${locked.join(" et ")} ${many ? "gardent leurs" : "garde ses"} cookies verrouillés tant `
      + `${many ? "qu'ils tournent (les fermer entièrement" : "qu'il tourne (le fermer entièrement"} les libère)`);
  }
  if (noSession.length) parts.push(`${noSession.join(", ")} : lisible${noSession.length > 1 ? "s" : ""} mais sans session YouTube`);
  return `${head}${parts.join(" ; ")}. Le plus simple : se connecter à YouTube une fois dans Firefox, ou exporter un cookies.txt `
    + "et le désigner par « cookiesFile » dans nr.config.json.";
}

// First useful line of a yt-dlp error: it often repeats two or three identical ones, which drowned
// the message in its own echo.
function firstLine(error) {
  const line = String(error || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "échec";
  return line.replace(/^ERROR:\s*/i, "").slice(0, 160);
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
  const job = resolveWithFallback(id).then((r) => {
    if (r.ok && r.url) cache.set(id, { url: r.url, at: Date.now() });
    inflight.delete(id);
    return r;
  });
  inflight.set(id, job);
  return job;
}

// UNE tranche bornée, redirections suivies. Rend la réponse amont, ou null quand googlevideo REFUSE
// l'URL (403/410) — à l'appelant de la renouveler, c'est le seul cas qui se rattrape.
function fetchSlice(url, start, end, onRequest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const headers = { "user-agent": UA, range: `bytes=${start}-${end}` };
    const upReq = https.get(url, { headers }, (up) => {
      const code = up.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && up.headers.location && redirects < MAX_REDIRECTS) {
        up.resume();
        fetchSlice(String(up.headers.location), start, end, onRequest, redirects + 1).then(resolve, reject);
        return;
      }
      if (code === 403 || code === 410) { up.resume(); resolve(null); return; }
      if (code !== 200 && code !== 206) { up.resume(); reject(new Error(`upstream ${code}`)); return; }
      resolve(up);
    });
    upReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => upReq.destroy(new Error("timeout")));
    upReq.on("error", reject);
    onRequest(upReq);
  });
}

// Plage demandée par le client. `bytes=N-` (sans fin) est le cas NORMAL d'un `<video>` : c'est celui
// que le relais borne lui-même. `bytes=-N` (N derniers octets) n'est jamais émis par un lecteur et
// exigerait la taille totale avant d'être traduit → lu depuis le début.
function parseRange(header) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(header || "").trim());
  return m ? { start: Number(m[1]), end: m[2] ? Number(m[2]) : null } : null;
}

// Taille TOTALE du fichier, lue dans le `Content-Range` de la tranche (`bytes a-b/total`).
function totalOf(up) {
  const m = /\/(\d+)\s*$/.exec(String(up.headers["content-range"] || ""));
  return m ? Number(m[1]) : Number(up.headers["content-length"] || 0);
}

function logResolveFailure(id, error) {
  const detail = String(error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 800);
  console.error(`ytstream: resolve ${id} failed: ${detail}`);
}

// GET `/ytstream?id=<videoId>` — relaie le flux avec les plages d'octets (seek et trim en dépendent).
// Découpage et renouvellement d'URL sont transparents : le renderer ne voit qu'une source stable.
async function serveYoutube(req, res, id) {
  if (!validId(id)) { res.writeHead(400).end("bad id"); return; }
  const first = await resolveStream(id);
  if (!first.ok || !first.url) {
    logResolveFailure(id, first.error);
    res.writeHead(502).end("resolve failed");
    return;
  }

  let url = first.url;
  let renewals = 0;
  let closed = false;
  /** @type {import("node:http").ClientRequest | null} */
  let upReq = null;
  // Item retiré du board / board fermé : on coupe la requête amont au lieu de la laisser couler.
  res.on("close", () => { closed = true; if (upReq) upReq.destroy(); });

  // Une tranche, avec renouvellement de l'URL tant que googlevideo la refuse.
  const slice = async (from, to) => {
    for (;;) {
      const up = await fetchSlice(url, from, to, (r) => { upReq = r; });
      if (up) return up;
      if (closed || renewals >= MAX_RENEWALS) return null;
      renewals++;
      const again = await resolveStream(id, true);
      if (!again.ok || !again.url) { logResolveFailure(id, again.error); return null; }
      url = again.url;
    }
  };

  const wanted = parseRange(req.headers.range);
  const start = wanted ? wanted.start : 0;
  let cursor = start;
  let end = 0;

  // Écrit une tranche dans la réponse SANS la clore, en respectant la contre-pression du webview et
  // sans jamais dépasser la plage annoncée (une amont qui ignorerait le Range enverrait tout).
  const pump = (up) => new Promise((done, fail) => {
    up.on("error", fail);
    up.on("end", done);
    up.on("data", (chunk) => {
      const room = end - cursor + 1;
      if (room <= 0) { up.destroy(); done(undefined); return; }
      const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
      cursor += part.length;
      if (!res.write(part)) { up.pause(); res.once("drain", () => up.resume()); }
    });
  });

  try {
    // La première tranche sert AUSSI à connaître la taille du fichier : elle décide des en-têtes.
    const firstTo = wanted && wanted.end != null ? Math.min(wanted.end, start + CHUNK - 1) : start + CHUNK - 1;
    const head = await slice(start, firstTo);
    if (!head) { if (!res.headersSent) res.writeHead(502).end("stream refused"); return; }
    const total = totalOf(head);
    if (!total) { head.resume(); res.writeHead(502).end("stream refused"); return; }
    end = wanted && wanted.end != null ? Math.min(wanted.end, total - 1) : total - 1;
    res.writeHead(wanted ? 206 : 200, {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=600",
      "Content-Type": String(head.headers["content-type"] || "video/mp4"),
      "Content-Length": String(end - start + 1),
      ...(wanted ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
    });

    await pump(head);
    while (!closed && cursor <= end) {
      const next = await slice(cursor, Math.min(cursor + CHUNK - 1, end));
      if (!next) break;
      await pump(next);
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(502).end("upstream error");
    else res.destroy();
  }
}

module.exports = { serveYoutube, resolveStream, needsCookies };
