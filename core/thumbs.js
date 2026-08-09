// @ts-check
// Vignettes (image fixe, CPU léger). File à priorité (carte visible > préchauffe de fond), cache
// disque (jpeg) + cache RAM (data URI) borné. THUMB_MAX ≈ cœurs/2 (le GPU est réservé aux proxies).

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getThumbDir, fsp, fileReady } = require('./config');
const { run, probeMedia } = require('./ffmpeg');
const { cacheIndex } = require('./cacheIndex');
const { proxyFrameSource } = require('./proxy');
const { resolveThumbSettings, thumbKeySuffix, thumbExt } = require('./thumbPresets');

// Instant « représentatif » d'un fichier ENTIER (time = AUTO_TIME) : 10 % de la durée, borné 2..120 s.
// Le début d'un rush est presque toujours NOIR (fondu d'ouverture, logo, amorce) → une vignette prise
// à t≈0 donne une case noire. Ne concerne QUE les clips entiers : un plan trimé garde son in-point
// (c'est l'image du plan, elle doit être exacte).
const AUTO_TIME = -1;
async function autoTime(filePath) {
  try {
    const p = await probeMedia(filePath);
    const d = Number(p && p.duration) || 0;
    if (d <= 4) return d > 0 ? d / 2 : 1;
    return Math.min(120, Math.max(2, d * 0.1));
  } catch (_) {
    return 1;
  }
}

// Gate de concurrence pour les vignettes (CPU, légères) ≈ cœurs/2 (16 cœurs → 8).
// À PRIORITÉ : la demande par carte VISIBLE (high, LIFO = la plus récente après un scroll passe
// devant) bat la préchauffe de fond du rush entier (low, FIFO). Sinon thumbsBatch génère le HAUT
// de la grille alors qu'on est scrollé au milieu → on attend des vignettes qu'on ne voit pas.
const THUMB_MAX = Math.max(6, Math.min(16, os.cpus().length - 2));
// La préchauffe ne peut jamais prendre tous les workers : deux places restent disponibles pour les
// cartes visibles. Sans cette réserve, un gros lot de fond fige l'affichage jusqu'à la fin des seeks.
const THUMB_LOW_MAX = Math.max(1, THUMB_MAX - 2);
let thumbActive = 0;
const thumbQHigh = [];
const thumbQLow = [];
const thumbInFlight = new Map();
function thumbPump() {
  while (true) {
    let task = null;
    if (thumbActive < THUMB_MAX && thumbQHigh.length) task = thumbQHigh.pop();
    else if (thumbActive < THUMB_LOW_MAX && thumbQLow.length) task = thumbQLow.shift();
    if (!task) break;
    thumbActive++;
    task();
  }
}
function thumbGate(fn, priority) {
  return new Promise((resolve) => {
    const task = () => { fn().then(resolve).finally(() => { thumbActive--; thumbPump(); }); };
    (priority === 'low' ? thumbQLow : thumbQHigh).push(task);
    thumbPump();
  });
}

// Cache RAM de session (clé -> CHEMIN du jpeg) : on ne renvoie plus de data URI base64 mais le
// chemin du fichier, servi via HTTP local → Chromium charge/décode/cache la vignette nativement
// (zéro base64, zéro gros payload IPC, zéro blob dans le heap JS). Le cache ne stocke donc que des
// chemins (minuscules) → on peut en garder beaucoup sans coût mémoire. Borné (LRU simple).
const thumbRam = new Map();
const THUMB_RAM_MAX = 50000;
function thumbRamSet(key, p) {
  if (thumbRam.has(key)) thumbRam.delete(key);
  else if (thumbRam.size >= THUMB_RAM_MAX) thumbRam.delete(thumbRam.keys().next().value);
  thumbRam.set(key, p);
}

// Évince du cache RAM les clés pointant sur des fichiers supprimés. INDISPENSABLE après une purge
// CIBLÉE (par rush) : le cache RAM garde des chemins, pas des données → sans éviction il continuerait
// à servir le chemin d'un jpeg effacé et la grille afficherait des vignettes cassées.
function thumbRamForget(files) {
  const gone = new Set(files || []);
  if (!gone.size) return;
  for (const [k, p] of thumbRam) if (gone.has(p)) thumbRam.delete(k);
}

// Le réglage utilisateur est un CRAN (léger/équilibré/net) : `thumbPresets` en tire hauteur et
// paramètres d'encodage. Accepte encore l'ancien `{height, quality}` — un réglage déjà écrit côté
// renderer ne doit pas se perdre au premier lancement.
function normalizeThumbSettings(settings) {
  return resolveThumbSettings(settings);
}

// La clé encode les paramètres RÉSOLUS, pas l'id du cran : retoucher la table des crans invalide donc
// le cache d'elle-même, au lieu de resservir des vignettes encodées sous d'anciennes valeurs.
function thumbKey(filePath, time, settings) {
  const suffix = thumbKeySuffix(resolveThumbSettings(settings));
  return thumbKeyFromSuffix(filePath, time, suffix);
}

function thumbKeyFromSuffix(filePath, time, suffix) {
  return crypto.createHash('md5').update(`${filePath}|${Number(time).toFixed(2)}|${suffix}`).digest('hex');
}

// Arguments ffmpeg d'une vignette : seek AVANT -i + -noaccurate_seek = keyframe le plus proche
// SANS décode-forward (MKV long-GOP HEVC = lent) → ~instantané. -an : pas d'audio.
// `-compression_level` est le levier vitesse/taille de libwebp (distinct de `-quality`) : le cran
// léger l'abaisse pour générer vite, ce qui est tout l'intérêt de ce cran.
function thumbArgs(filePath, time, settings) {
  const s = resolveThumbSettings(settings);
  const codec = s.format === 'webp'
    ? ['-vcodec', 'libwebp', '-lossless', '0', '-compression_level', String(s.webpEffort), '-quality', String(s.webpQuality)]
    : ['-vcodec', 'mjpeg', '-q:v', String(s.jpegQscale)];
  return [
    '-v', 'error', '-noaccurate_seek', '-ss', String(time), '-i', filePath, '-an',
    '-frames:v', '1', '-vf', `scale=-2:${s.height}`, '-f', 'image2pipe', ...codec, '-',
  ];
}

async function fastestThumbInput(filePath, time) {
  try { return await proxyFrameSource(filePath, time) || { input: filePath, time }; }
  catch (_) { return { input: filePath, time }; }
}

// Renvoie le CHEMIN du jpeg en cache (le renderer le sert via HTTP local). Cache RAM (chemin) →
// disque → ffmpeg. On ne lit JAMAIS le contenu du fichier ici (plus de readFile/base64) : c'est
// Chromium qui le charge → vignette à l'écran nettement plus vite, mémoire JS minime.
async function thumbnail(filePath, time = 1, priority = 'high', settings) {
  // Le pont HTTP sérialise un `time` absent en `null` (JSON undefined→null) → le défaut de param ne
  // s'applique pas. On le rétablit ici, sinon ffmpeg reçoit `-ss null` et échoue (vignette manquante).
  if (time == null) time = 1;
  // AUTO : le clip entier n'a pas d'in-point utile → viser une frame représentative (pas le noir
  // du début). Résolu AVANT la clé de cache : deux demandes auto du même fichier partagent la clé.
  if (time === AUTO_TIME) time = await autoTime(filePath);
  const s = normalizeThumbSettings(settings);
  const key = thumbKey(filePath, time, s);
  const ram = thumbRam.get(key);
  if (ram) return ram;                              // cache RAM : chemin connu, instantané
  // cache disque : réouverture d'un rush = vignettes instantanées (pas de ffmpeg).
  const cacheFile = path.join(getThumbDir(), `${key}.${thumbExt(s.format)}`);
  if (await fileReady(cacheFile)) { thumbRamSet(key, cacheFile); cacheIndex().touch(cacheFile); return cacheFile; }
  const running = thumbInFlight.get(key);
  if (running) return running;
  const job = thumbGate(async () => {
    if (thumbRam.has(key)) return thumbRam.get(key);   // généré entre-temps (course)
    if (await fileReady(cacheFile)) { thumbRamSet(key, cacheFile); cacheIndex().touch(cacheFile); return cacheFile; }
    let lastErr = 'thumb échec';
    for (let attempt = 0; attempt < 2; attempt++) {  // retry : ffmpeg échoue parfois sous charge
      try {
        const source = attempt === 0 ? await fastestThumbInput(filePath, time) : { input: filePath, time };
        const buf = await run('ffmpeg', thumbArgs(source.input, source.time, s), { encoding: 'buffer', timeout: 20000 });
        if (buf && buf.length) {
          await fsp.writeFile(cacheFile, buf);
          thumbRamSet(key, cacheFile);
          cacheIndex().record({ kind: 'thumb', file: cacheFile, source: filePath, bytes: buf.length });
          return cacheFile;
        }
      } catch (e) { lastErr = String(e.stderr || e); }
    }
    return { error: lastErr };
  }, priority);
  thumbInFlight.set(key, job);
  try { return await job; } finally { if (thumbInFlight.get(key) === job) thumbInFlight.delete(key); }
}

// Pré-génère les vignettes manquantes d'un rush par seeks `-ss` RAPIDES en parallèle (gate
// thumbActive), triées (haut d'abord) et écrites au cache au fil de l'eau → elles apparaissent
// progressivement et vite, en même temps que les proxies (encode GPU). PAS un seul gros passage
// `select` (qui décode tout le fichier séquentiellement et n'écrit qu'à la fin = grille noire
// longtemps). items: [{ time, frame }]. Mêmes clés de cache que thumbnail().
const batchKeys = new Map();
async function thumbsBatch(filePath, items, settings) {
  const s = normalizeThumbSettings(settings);
  const seen = new Set();
  const todo = [];
  for (const it of items || []) {
    if (typeof it.time !== 'number' || it.time < 0) continue;
    const t = Number(it.time);
    const key = thumbKey(filePath, t, s);
    if (seen.has(key)) continue;
    seen.add(key);
    if (thumbRam.has(key)) continue;           // déjà en RAM
    const cacheFile = path.join(getThumbDir(), `${key}.${thumbExt(s.format)}`);
    if (await fileReady(cacheFile)) continue;  // déjà en cache disque
    todo.push({ time: t, cacheFile, key });
  }
  if (!todo.length) return { ok: true, made: 0 };
  todo.sort((a, b) => a.time - b.time);   // haut de la grille d'abord

  // un seul batch courant : si un nouveau démarre (autre clip), l'ancien s'arrête tout seul.
  const myKey = `${filePath}|${todo.length}|${todo[0].time}|${todo[todo.length - 1].time}`;
  batchKeys.set(filePath, myKey);

  let made = 0;
  await Promise.all(todo.map(async (t) => {
    if (batchKeys.get(filePath) !== myKey) return;   // remplacé par un batch plus récent → on lâche
    // entre-temps généré par le lazy per-card ? on saute (pas de double encode).
    if (thumbRam.has(t.key) || await fileReady(t.cacheFile)) return;
    const running = thumbInFlight.get(t.key);
    if (running) { await running; return; }
    const job = thumbGate(async () => {
      try {
        const source = await fastestThumbInput(filePath, t.time);
        let buf;
        try { buf = await run('ffmpeg', thumbArgs(source.input, source.time, s), { encoding: 'buffer', timeout: 20000 }); }
        catch (_) { buf = await run('ffmpeg', thumbArgs(filePath, t.time, s), { encoding: 'buffer', timeout: 20000 }); }
        if (buf && buf.length) {
          await fsp.writeFile(t.cacheFile, buf);   // cache disque écrit aussitôt
          thumbRamSet(t.key, t.cacheFile);
          cacheIndex().record({ kind: 'thumb', file: t.cacheFile, source: filePath, bytes: buf.length });
          made++;
        }
      } catch (_) {}
    }, 'low');
    thumbInFlight.set(t.key, job);
    try { await job; } finally { if (thumbInFlight.get(t.key) === job) thumbInFlight.delete(t.key); }
  }));
  return { ok: true, made };
}

// Résout en LOT les chemins des vignettes DÉJÀ en cache (RAM ou disque) SANS rien générer. Un seul
// appel RPC pour toute une grille → le renderer amorce son cache et affiche les <img> sans 1 RPC par
// carte (c'était la saturation des ~6 sockets HTTP qui rendait le scroll lent malgré le cache plein).
// items: [{ path, time }] → renvoie [{ path, time, file: <chemin jpeg>|null }] (null = pas encore généré).
async function thumbResolveOne(filePath, time, settings) {
  const s = normalizeThumbSettings(settings);
  const key = thumbKey(filePath, time, s);
  const ram = thumbRam.get(key);
  if (ram) return ram;
  const cacheFile = path.join(getThumbDir(), `${key}.${thumbExt(s.format)}`);
  if (await fileReady(cacheFile)) { thumbRamSet(key, cacheFile); cacheIndex().touch(cacheFile); return cacheFile; }
  return null;
}
async function thumbsResolve(items, settings) {
  return Promise.all((items || []).map(async (it) => {
    const time = Number(it && it.time);
    if (!it || !it.path || !Number.isFinite(time)) return { path: it && it.path, time: it && it.time, file: null };
    let file = null;
    try { file = await thumbResolveOne(it.path, time, settings); } catch (_) {}
    return { path: it.path, time: it.time, file };
  }));
}

// Vide TOUT le cache de vignettes (RAM + jpeg disque). Purge en bloc, sans distinction de rush :
// appelée par cacheAdmin quand l'utilisateur demande le type « vignettes » en entier. Une purge
// ciblée (par rush/projet) passe par l'index latéral, pas par ici. Saute les fichiers verrouillés.
async function cleanThumbs() {
  thumbRam.clear();
  const dir = getThumbDir();
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let entries = [];
  const gone = [];
  try { entries = await fsp.readdir(dir); } catch (_) { return { ok: true, files, bytes, skipped }; }
  for (const f of entries) {
    const p = path.join(dir, f);
    try {
      const sz = (await fsp.stat(p)).size;
      await fsp.rm(p, { force: true });
      files++; bytes += sz;
      gone.push(p);
    } catch (_) { skipped++; }
  }
  cacheIndex().forget(gone);
  return { ok: true, files, bytes, skipped };
}

module.exports = { thumbnail, thumbsBatch, thumbsResolve, cleanThumbs, thumbRamForget, normalizeThumbSettings, thumbKey, thumbKeyFromSuffix, thumbArgs };
