// @ts-check
// Proxies de lecture (NVENC NVIDIA / AMF AMD / QSV Intel, puis H.264 CPU universel). File à
// PRIORITÉ (survol/clic > préchauffe) + concurrence ADAPTATIVE (converge vers le nb de sessions
// matérielles que le pilote accepte) + annulation (carte hors écran → kill ffmpeg).

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ffBin, getProxyDir, fsp, fileReady } = require('./config');
const { cacheIndex } = require('./cacheIndex');
const { getCapabilities } = require('./export/capabilities');
const { selectProxyEncoder, proxyVideoArgs, proxyContainerArgs, isHardwareBusy } = require('./proxyEncoder');

// Catalogue léger des proxies terminés. Les métadonnées vivent à côté du fichier encodé afin qu'une
// vignette puisse, même après redémarrage du core, décoder quelques millisecondes de proxy plutôt que
// refaire un seek long-GOP dans le rush original. Les sidecars ne sont jamais servis directement.
const proxyFrames = new Map();
let proxyMetaReady = null;
function proxyMetaPath(file) { return `${file}.nrproxy.json`; }
function rememberProxy(meta) {
  const source = path.resolve(meta.source);
  const list = proxyFrames.get(source) || [];
  const next = list.filter((x) => x.file !== meta.file);
  next.push({ ...meta, source });
  proxyFrames.set(source, next.slice(-200));
}
async function writeProxyMeta(file, source, start, duration, container, end = null) {
  const meta = { file, source: path.resolve(source), start, duration, container, end };
  rememberProxy(meta);
  try { await fsp.writeFile(proxyMetaPath(file), JSON.stringify(meta)); } catch (_) {}
}
async function hydrateProxyMetadata() {
  if (proxyMetaReady) return proxyMetaReady;
  proxyMetaReady = (async () => {
    let names = [];
    try { names = await fsp.readdir(getProxyDir()); } catch (_) { return; }
    await Promise.all(names.filter((n) => n.endsWith('.nrproxy.json')).map(async (name) => {
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(getProxyDir(), name), 'utf8'));
        if (meta?.file && meta?.source && await fileReady(meta.file)) rememberProxy(meta);
      } catch (_) {}
    }));
  })();
  return proxyMetaReady;
}

// Renvoie un média court déjà disponible qui couvre l'instant demandé. Le temps est relatif au proxy.
// Les WebP animés sont exclus : leur seek n'est pas assez fiable pour une capture ponctuelle.
async function proxyFrameSource(input, time) {
  await hydrateProxyMetadata();
  const source = path.resolve(input);
  const list = proxyFrames.get(source) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (p.container === 'webp' || time < p.start || time >= p.start + p.duration) continue;
    if (await fileReady(p.file)) {
      cacheIndex().touch(p.file);
      return { input: p.file, time: Math.max(0, time - p.start) };
    }
  }
  return null;
}

// File d'attente proxy à PRIORITÉ + concurrence ADAPTATIVE qui s'AUTO-RÉPARE. Le survol/clic
// ('high') passe devant la préchauffe de fond ('low'). La limite de sessions matérielles simultanées
// varie selon la carte/le pilote (les pilotes récents lèvent le cap conso → souvent 8..illimité ;
// et Resolve en consomme aussi). On VISE HAUT (PROXY_MAX_HI) et on baisse d'un cran SEULEMENT
// quand le GPU refuse vraiment une session — puis on REMONTE d'un cran après une série de succès
// (HEAL_STREAK) : un refus transitoire (Resolve qui prend 2 sessions une seconde) ne fige plus le
// plafond au plancher pour tout le batch. Le job refusé se ré-enfile (backoff). Plancher PROXY_MAX_LO.
const PROXY_MAX_HI = 12;
const PROXY_MAX_LO = 3;
const HEAL_STREAK = 4;          // succès consécutifs avant de regagner +1 créneau
let proxyMax = PROXY_MAX_HI;
let proxyActive = 0;
let proxyOkStreak = 0;          // série de succès depuis le dernier refus (pilote la remontée)
const qHigh = [];
const qLow = [];
const cancelledTokens = new Set();   // tokens annulés (carte sortie de l'écran) — sautés au pump
const proxyChildren = new Map();     // token -> child ffmpeg EN COURS (kill immédiat à l'annulation)

// Prend le prochain job. High = LIFO : la demande la PLUS RÉCENTE = la carte qu'on regarde
// MAINTENANT (après un scroll) passe devant les demandes périmées (cartes scrollées au-dessus,
// hors écran). Low (préchauffe de fond) reste FIFO. Les jobs annulés entre-temps sont jetés ici.
function takeJob() {
  while (qHigh.length) {
    const j = qHigh.pop();
    if (j.token != null && cancelledTokens.has(j.token)) { cancelledTokens.delete(j.token); j.resolve({ ok: false, cancelled: true }); continue; }
    return j;
  }
  while (qLow.length) {
    const j = qLow.shift();
    if (j.token != null && cancelledTokens.has(j.token)) { cancelledTokens.delete(j.token); j.resolve({ ok: false, cancelled: true }); continue; }
    return j;
  }
  return null;
}
function proxyPump() {
  while (proxyActive < proxyMax) {
    const job = takeJob();
    if (!job) break;
    proxyActive++;
    job.fn().then((res) => {
      // Le pilote a refusé une session (trop de sessions concurrentes) : baisse le plafond et
      // ré-enfile le job après un court backoff (le temps qu'une session se libère). unshift =
      // bas de la pile → ne repasse PAS devant les cartes visibles (LIFO).
      if (res && res.__busy) {
        proxyMax = Math.max(PROXY_MAX_LO, proxyMax - 1);
        proxyOkStreak = 0;   // refus → on repart à zéro avant de retenter de remonter
        job.tries = (job.tries || 0) + 1;
        if (job.tries <= 8) {
          setTimeout(() => { (job.prio === 'low' ? qLow : qHigh).unshift(job); proxyPump(); }, 200 * job.tries);
          return;   // pas de resolve : nouvelle tentative au prochain pump
        }
        return job.resolve({ ok: false, error: res.error });   // abandon après trop d'essais
      }
      // Encode réussi : après HEAL_STREAK succès d'affilée, regagne un créneau (jusqu'à HI) → le
      // plafond remonte tout seul quand Resolve libère ses sessions, au lieu de rester collé au plancher.
      if (res && res.ok && res.__hardware && proxyMax < PROXY_MAX_HI && ++proxyOkStreak >= HEAL_STREAK) {
        proxyMax++; proxyOkStreak = 0; proxyPump();
      }
      job.resolve(res);
    }).finally(() => { proxyActive--; proxyPump(); });
  }
}
function proxyGate(fn, priority, token) {
  return new Promise((resolve) => {
    const job = { fn, resolve, prio: priority === 'low' ? 'low' : 'high', tries: 0, token };
    (job.prio === 'low' ? qLow : qHigh).push(job);
    proxyPump();
  });
}
// Annule la demande de proxy d'une carte qui vient de quitter l'écran : si encore en file, elle
// sera jetée au pump ; si déjà en cours d'encode, on TUE le ffmpeg → libère un créneau matériel tout
// de suite pour les cartes réellement visibles. Idempotent.
function proxyCancel(token) {
  if (token == null) return;
  cancelledTokens.add(token);
  const ch = proxyChildren.get(token);
  if (ch) { try { ch.kill('SIGKILL'); } catch (_) {} }
  if (cancelledTokens.size > 4000) cancelledTokens.clear();   // anti-fuite (annulations sans job)
}

// Annule un LOT de tokens en UN appel (bouton « Arrêter » de la pré-génération) : évite des
// centaines de requêtes /rpc séparées (une par plan) qui inondaient le réseau et le journal.
function proxyCancelMany(tokens) {
  if (Array.isArray(tokens)) for (const t of tokens) proxyCancel(t);
}

// STOP global, à toute épreuve : vide les DEUX files (jobs en attente résolus « annulés ») et
// SIGKILL tous les ffmpeg EN VOL — sans dépendre des tokens (un token oublié ne peut plus laisser
// un encode tourner). Renvoie le nb de process tués. La grille re-demandera au survol si besoin.
function proxyCancelAll() {
  let killed = 0;
  while (qHigh.length) qHigh.pop().resolve({ ok: false, cancelled: true });
  while (qLow.length) qLow.shift().resolve({ ok: false, cancelled: true });
  for (const [tok, ch] of proxyChildren) {
    cancelledTokens.add(tok);   // marque annulé → le close SIGKILL n'est pas traité en erreur
    try { ch.kill('SIGKILL'); killed++; } catch (_) {}
  }
  return { ok: true, killed };
}

// Encodes de proxy EN VOL + demandes en file. Sert de signal « NetsuRush travaille » à la
// surveillance mémoire (core/optimize/watchdog.js), qui ne s'arme que pendant une tâche lourde.
function proxyActiveCount() {
  return { encoding: proxyChildren.size, queued: qHigh.length + qLow.length };
}

// Paliers de hauteur proxy. La grille décode autant de <video> que de cartes visibles → le coût
// décode/encode/NVDEC est ∝ pixels. On encode à la taille RÉELLE de la cellule (mesurée côté
// renderer), snappée à un palier (cache borné). Une cellule 360p = 4× moins de pixels qu'en 520p
// → bien plus de cartes jouent à la fois, encode plus rapide, scroll fluide. 520 = plafond (qualité
// volontairement basse pour une génération nettement plus rapide).
const PROXY_TIERS = [360, 480, 520, 720];
function snapProxyHeight(h) {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return 480;
  for (const t of PROXY_TIERS) if (n <= t) return t;
  return 720;
}

// ffmpeg ANNULABLE : spawn (vs execFile) pour pouvoir tuer le process si la carte quitte l'écran.
// Le child est enregistré par token le temps de l'encode → proxyCancel(token) peut le SIGKILL.
// Error enrichie d'un encode ffmpeg annulable : `stderr` (sortie ffmpeg) + `cancelled` (kill volontaire).
/** @typedef {Error & { cancelled?: boolean, stderr?: string }} FfError */
function ffSpawnCancellable(args, token, timeout) {
  return new Promise((resolve, reject) => {
    if (token != null && cancelledTokens.has(token)) { const e = /** @type {FfError} */ (new Error('cancelled')); e.cancelled = true; return reject(e); }
    const ch = spawn(ffBin('ffmpeg'), args);
    if (token != null) proxyChildren.set(token, ch);
    let err = '';
    const to = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (_) {} }, timeout);
    ch.stderr.on('data', (d) => { err += d.toString(); });
    ch.on('error', (e) => { clearTimeout(to); if (token != null) proxyChildren.delete(token); /** @type {FfError} */ (e).stderr = err; reject(e); });
    ch.on('close', (code, signal) => {
      clearTimeout(to);
      if (token != null) proxyChildren.delete(token);
      if (code === 0) return resolve();
      const e = /** @type {FfError} */ (new Error('ffmpeg exit ' + (code != null ? code : signal)));
      e.stderr = err;
      // tué par proxyCancel (token marqué) = annulation volontaire, pas une vraie erreur.
      e.cancelled = signal === 'SIGKILL' && token != null && cancelledTokens.has(token);
      reject(e);
    });
  });
}

// Encode un proxy en fichier TEMP puis rename (atomique) → 'out' n'existe que s'il est
// complet (jamais de MP4 partiel/corrompu servi = carte noire permanente). Retry 1×.
let proxyTmpSeq = 0;
async function encodeProxy(input, start, end, out, height, token, resolved, preset, audio, attempt = 0) {
  // Garde : os.tmpdir() peut être purgé EN COURS de session (Windows Storage Sense) → recrée le
  // dossier avant l'encode, sinon ffmpeg ne peut écrire le .tmp et l'aperçu échoue silencieusement.
  try { await fsp.mkdir(getProxyDir(), { recursive: true }); } catch (_) {}
  const tmp = `${out}.${proxyTmpSeq++}.tmp`;
  // Aperçu : 4s max (lecture en boucle), borne basse 0.6s pour les plans ultra-courts.
  // 4 plutôt que 6 = ~33% d'encode en moins par proxy → 1re image à l'écran encore plus tôt.
  const dur = Math.min(Math.max(0.6, end - start), 4);
  // Proxy = HEVC/H.264 encodé par le moteur matériel réellement validé sur cette machine. À défaut,
  // libx264 ultrafast garantit que NetsuCut reste utilisable ; on N'utilise PAS libx265 CPU.
  // Décode source = CPU léger (le full-GPU NVDEC+scale_cuda par process = init CUDA trop lente
  // pour des petits segments, testé 5.4s vs 0.86s). Retry pilote sur échec transitoire.
  // -tag:v hvc1 OBLIGATOIRE (le tag 'hev1' par défaut n'est pas lu par <video>).
  // -pix_fmt yuv420p = 8-bit (profil Main "probably" ; le 10-bit Main10 non garanti côté <video>).
  // Codec selon le réglage partagé : HEVC Main/H.264 Main en MP4 8-bit, ou WebM VP8. Le même
  // fichier est consommé par la grille et le lecteur latéral.
  const vcodec = [...proxyVideoArgs(resolved, preset), ...proxyContainerArgs(resolved)];
  const acodec = !audio
    ? ['-an']
    : resolved.container === 'webm'
      ? ['-c:a', 'libvorbis', '-b:a', '64k']
      : ['-c:a', 'aac', '-b:a', '96k'];
  const container = resolved.container;
  const faststart = container === 'mp4' ? ['-movflags', '+faststart'] : [];
  try {
    await ffSpawnCancellable([
      '-hide_banner', '-loglevel', 'error',
      '-y', '-ss', String(start), '-i', input, '-t', String(dur),
      '-vf', `scale=-2:${height}:flags=fast_bilinear`,
      // Encode le PLUS rapide possible (cold-start = priorité). Réglages propres à NVENC/AMF/QSV ;
      // -bf 0 : redémarrage de boucle net.
      ...vcodec,
      ...acodec,
      ...faststart, '-f', container, tmp,
    ], token, 30000);
    if (!(await fileReady(tmp))) throw new Error('proxy vide');
    await fsp.rename(tmp, out);
    // Après le rename atomique seulement : `out` n'existe qu'une fois complet, l'index ne référence
    // donc jamais un proxy partiel.
    cacheIndex().record({ kind: 'proxy', file: out, source: input });
    await writeProxyMeta(out, input, start, dur, container, end);
  } catch (e) {
    try { await fsp.rm(tmp, { force: true }); } catch (_) {}
    if (e && e.cancelled) throw e;   // annulé (carte hors écran) : ne pas retenter
    // Refus de session matériel : ne pas retenter ici (ça garderait le créneau occupé) — remonter
    // pour que la file baisse le plafond et ré-enfile plus tard.
    if (isHardwareBusy(e)) throw e;
    if (resolved.vendor === 'cpu' && attempt < 2) {
      return encodeProxy(input, start, end, out, height, token, resolved, preset, audio, attempt + 1);
    }
    throw e;
  }
}

async function proxySegment({ input, start, end, priority, height, token, codec, settings }) {
  const requestedHeight = settings?.height ?? height;
  const h = snapProxyHeight(requestedHeight);
  const configured = settings?.format === 'webm' ? 'vp8' : settings?.format === 'h264' ? 'h264' : 'hevc';
  const vc = codec === 'h264' || codec === 'hevc' ? codec : configured;
  const configuredEngine = settings?.engine === 'nvenc' || settings?.engine === 'amf' || settings?.engine === 'qsv' || settings?.engine === 'cpu' ? settings.engine : 'auto';
  const preset = settings?.preset === 'level2' || settings?.preset === 'level3' ? settings.preset : 'level1';
  const audio = settings?.audio !== false;
  let caps;
  try { caps = await getCapabilities(); } catch (_) { caps = { h264Encoder: null, h265Encoder: null, codecEncoderOptions: {} }; }
  const resolved = selectProxyEncoder(vc, caps, configuredEngine);
  // Sans moteur matériel, limite immédiatement la file : trois libx264/libvpx ultrafast en parallèle
  // restent réactifs sans saturer tous les cœurs. Un moteur matériel remontera ensuite par HEAL_STREAK.
  if (resolved.vendor === 'cpu') proxyMax = Math.min(proxyMax, PROXY_MAX_LO);
  return proxyGate(async () => {
    try {
      // clé versionnée (codec+encodeur+params+hauteur) : changer de GPU régénère un fichier propre.
      const makeOut = (enc) => {
        const key = crypto.createHash('md5').update(`${input}|${start}|${end}|${vc}-${enc.encoder}-${preset}-${audio ? 'audio' : 'mute'}-v4-${h}`).digest('hex');
        return path.join(getProxyDir(), `${key}.${enc.extension}`);
      };
      let activeEncoder = resolved;
      let out = makeOut(activeEncoder);
      if (!(await fileReady(out))) {
        try {
          await encodeProxy(input, start, end, out, h, token, activeEncoder, preset, audio, 0);
        } catch (error) {
          if (isHardwareBusy(error) || activeEncoder.vendor === 'cpu') throw error;
          // Pilote ancien ou arguments spécifiques refusés malgré la sonde générique : ne bloque
          // jamais NetsuCut. Le cache CPU est distinct et l'accélération sera retentée après purge.
          // Un moteur matériel explicitement choisi qui échoue retombe sur l'encode CPU rapide.
          // Seul le choix utilisateur « CPU + HEVC » autorise libx265 ; l'automatique reste libx264.
          activeEncoder = selectProxyEncoder(
            vc,
            { h264Encoder: null, h265Encoder: null },
            configuredEngine === 'cpu' ? 'cpu' : 'auto',
          );
          proxyMax = Math.min(proxyMax, PROXY_MAX_LO);
          out = makeOut(activeEncoder);
          if (!(await fileReady(out))) await encodeProxy(input, start, end, out, h, token, activeEncoder, preset, audio, 0);
        }
      } else {
        cacheIndex().touch(out);
        const duration = Math.min(Math.max(0.6, end - start), 4);
        await writeProxyMeta(out, input, start, duration, activeEncoder.container, end);
      }
      return { ok: true, path: out, __hardware: activeEncoder.vendor !== 'cpu' };
    } catch (e) {
      if (e && e.cancelled) return { ok: false, cancelled: true };   // annulation = pas une erreur
      // fin du stderr = la vraie erreur ffmpeg (pas la bannière).
      const msg = String((e && e.stderr) || e).trim().split('\n').slice(-3).join(' ').slice(-300);
      // __busy : refus de session matériel → la file gère (baisse + ré-enfile), pas une erreur finale.
      if (isHardwareBusy(e)) return { __busy: true, error: msg };
      return { ok: false, error: msg };
    }
  }, priority, token);
}

// Vide TOUT le cache de proxies. Purge en bloc, sans distinction de rush : appelée par cacheAdmin
// quand l'utilisateur demande le type « proxies » en entier (une purge ciblée passe par l'index).
// Saute les fichiers verrouillés (en cours de lecture). NE TOUCHE PAS aux vignettes : elles sont
// minuscules, réutilisables, et coûteuses à régénérer à froid.
async function cleanProxies() {
  const dir = getProxyDir();
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
  proxyFrames.clear();
  proxyMetaReady = null;
  return { ok: true, files, bytes, skipped };
}

// Évince les fichiers supprimés par une purge ciblée du catalogue RAM. Sans cela une vignette peut
// encore tenter de décoder un proxy qui n'existe plus jusqu'au redémarrage du core.
function proxyForget(files) {
  const gone = new Set((files || []).map((file) => path.resolve(String(file))));
  if (!gone.size) return;
  for (const [source, list] of proxyFrames) {
    const kept = list.filter((entry) => !gone.has(path.resolve(entry.file)));
    if (kept.length) proxyFrames.set(source, kept);
    else proxyFrames.delete(source);
  }
  proxyMetaReady = null;
}

module.exports = { proxySegment, proxyCancel, proxyCancelMany, proxyCancelAll, proxyActiveCount, proxyFrameSource, cleanProxies, proxyForget };
