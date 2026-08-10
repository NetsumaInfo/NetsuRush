// @ts-check
// Sonde les capacités RÉELLES d'encodage de cette machine — ce qui est proposé à l'utilisateur.
//
// POURQUOI une vraie sonde : `ffmpeg -encoders` LISTE des encodeurs que le matériel ne sait pas
// exécuter. Une RTX 30xx annonce `av1_nvenc` alors qu'elle n'a AUCUN moteur AV1 (RTX 40+ seulement) ;
// un ffmpeg Windows annonce `h264_qsv`/`h264_amf` même sans GPU Intel/AMD. Lister ≠ pouvoir encoder.
// Seul juge fiable : encoder VRAIMENT une frame avec les arguments EXACTS du codec (ceux d'encodeArgs)
// et regarder si ffmpeg sort en succès. Un codec qui échoue ici n'est jamais affiché (exigence
// produit : « s'il est pas compatible, tu l'affiches tout simplement pas »).
//
// Coût : ~0,1-0,3 s par sonde, en parallèle limité, puis CACHE DISQUE (NR_HOME/export-caps.json)
// invalidé dès que le binaire ffmpeg change (chemin/taille/mtime) ou que le schéma évolue.

const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const ffmpeg = require('../ffmpeg');
const { CONFIG, NR_HOME } = require('../config');
const { videoEncodeArgs, hwCandidates, listCodecs } = require('./encodeArgs');

// Incrémenter à chaque changement des arguments d'encodage ou de la logique de sonde → invalide les
// caches déjà écrits chez les utilisateurs.
const PROBE_SCHEMA = 5;
const CACHE_PATH = path.join(NR_HOME, 'export-caps.json');

// 320x240 : NVENC REFUSE les dimensions trop petites (« Frame Dimension less than the minimum
// supported value » en 64x64) et DNxHR exige des dimensions paires → une mire trop petite ferait
// échouer des codecs parfaitement fonctionnels (faux négatif = codec masqué à tort).
const TEST_SRC = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-frames:v', '1'];

// Sondes simultanées : les encodeurs matériels ont un nombre de sessions limité et se gênent →
// rester bas. Le cache disque fait que ce coût n'est payé qu'une fois.
const PROBE_CONCURRENCY = 3;
const HW_PROFILE_CANDIDATES = {
  h264: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
  h265: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf'],
};

/** Arguments exacts utilisés par python/upscaler/codecs.py pour sonder un profil matériel. */
function upscaleProbeArgs(encoder, profile, pix, family) {
  let args;
  if (encoder.endsWith('_nvenc')) {
    args = ['-c:v', encoder, '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '18',
      '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1'];
  } else if (encoder.endsWith('_qsv')) {
    args = ['-c:v', encoder, '-preset', 'medium', '-global_quality', '18'];
  } else {
    args = ['-c:v', encoder, '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp',
      '-qp_i', '18', '-qp_p', '18'];
  }
  args.push('-profile:v', profile);
  const nativePix = encoder.endsWith('_nvenc') ? pix : (pix.includes('10') ? 'p010le' : 'nv12');
  args.push('-pix_fmt', nativePix);
  if (family === 'h265') args.push('-tag:v', 'hvc1');
  return args;
}

/**
 * Encode UNE frame avec `args` vers le muxer null. Vrai = cette machine sait exécuter cet encodeur
 * avec ces arguments précis.
 * @param {string[]} args @returns {Promise<boolean>}
 */
async function canEncode(args) {
  try {
    await ffmpeg.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...TEST_SRC, ...args, '-f', 'null', '-'], { timeout: 30000 });
    return true;
  } catch (_) {
    return false;
  }
}

/** Encodeurs présents dans `ffmpeg -encoders` (pré-filtre : inutile de sonder un encodeur absent). */
async function listedEncoders() {
  let out = '';
  try { out = String(await ffmpeg.run('ffmpeg', ['-hide_banner', '-encoders'])); } catch (_) { return new Set(); }
  const set = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*[A-Z.]{6}\s+(\S+)/);
    if (m) set.add(m[1]);
  }
  return set;
}

/** Exécute `worker(i)` pour i∈[0,count[ avec au plus `conc` en vol. @param {number} count @param {number} conc @param {(i:number)=>Promise<void>} worker */
async function runPool(count, conc, worker) {
  let next = 0;
  const n = Math.max(1, Math.min(conc, count));
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const i = next++;
      if (i >= count) break;
      await worker(i);
    }
  }));
}

/** Signature du binaire ffmpeg (chemin + taille + mtime) : le cache meurt si ffmpeg est remplacé. */
function ffmpegSignature() {
  const bin = (CONFIG && CONFIG.ffmpeg) || 'ffmpeg';
  try {
    const st = fs.statSync(bin);
    return `${bin}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch (_) {
    return String(bin);
  }
}

/**
 * @typedef {object} ExportCapabilities
 * @property {string[]} codecs           codecs RÉELLEMENT encodables sur cette machine
 * @property {string[]} cpuCodecs        codecs RÉELLEMENT encodables par le CPU
 * @property {Record<string, string|null>} codecEncoders  codec → encodeur matériel validé (null = CPU)
 * @property {Record<string, string[]>} codecEncoderOptions codec → tous les encodeurs matériels validés
 * @property {Record<string, string[]>} upscaleProfileEncoderOptions profil détaillé du hub vidéo →
 *                                                   encodeurs matériels validés avec ses vrais arguments
 * @property {string[]} hwEncoders       encodeurs matériels RETENUS (diagnostic). Un encodeur qui
 *                                       marche mais qu'un vendeur préféré coiffe n'y figure pas
 *                                       (ex. AMF vivant mais NVENC choisi partout).
 * @property {boolean} hasGpuEncoder
 * @property {string|null} h264Encoder
 * @property {string|null} h265Encoder
 * @property {string|null} av1Encoder
 * @property {boolean} webp
 * @property {number} schema
 * @property {string} signature
 */

/**
 * Sonde complète. Stratégie en 2 temps pour limiter les spawns :
 *  1. éliminer les vendeurs matériels MORTS (un test par encodeur listé) — sur une machine NVIDIA,
 *     ça écarte tout QSV/AMF d'un coup ;
 *  2. pour chaque codec, sonder ses arguments réels (CPU) + son meilleur encodeur matériel survivant.
 * @returns {Promise<ExportCapabilities>}
 */
async function runProbe() {
  const listed = await listedEncoders();
  const codecs = listCodecs();

  // 1. Vendeurs matériels réellement vivants (test nu, sans profil : « ce moteur existe-t-il ? »).
  const hwAll = [...new Set(codecs.flatMap((c) => hwCandidates(c)))].filter((e) => listed.has(e));
  /** @type {Set<string>} */
  const hwAlive = new Set();
  await runPool(hwAll.length, PROBE_CONCURRENCY, async (i) => {
    const enc = hwAll[i];
    if (await canEncode(['-c:v', enc])) hwAlive.add(enc);
  });

  // 2. Par codec : arguments réels. Le matériel est sondé AVEC son profil/pix_fmt (h264_nvenc vit,
  //    mais pas en 10 bits → h264_high10 tombera en CPU, pas en erreur d'export).
  /** @type {Record<string, string|null>} */
  const codecEncoders = {};
  /** @type {Record<string, string[]>} */
  const codecEncoderOptions = {};
  /** @type {Record<string, boolean>} */
  const cpuOk = {};
  await runPool(codecs.length, PROBE_CONCURRENCY, async (i) => {
    const codec = codecs[i];
    cpuOk[codec] = await canEncode(videoEncodeArgs(codec, null));
    const options = [];
    for (const enc of hwCandidates(codec)) {
      if (!hwAlive.has(enc)) continue;
      if (await canEncode(videoEncodeArgs(codec, enc))) options.push(enc);
    }
    codecEncoderOptions[codec] = options;
    codecEncoders[codec] = options[0] || null;
  });

  // Profils détaillés du hub Traitements vidéo. L'export général force volontairement le 4:4:4
  // sur CPU, mais NVENC HEVC sait réellement encoder RExt 4:4:4 sur certaines cartes. On le sonde
  // séparément avec les arguments exacts du pipeline upscale au lieu de l'inférer depuis Main 10.
  const upscaleProfiles = {
    h264_baseline: { family: 'h264', profile: 'baseline', pix: 'yuv420p' },
    h264_main: { family: 'h264', profile: 'main', pix: 'yuv420p' },
    h264_high: { family: 'h264', profile: 'high', pix: 'yuv420p' },
    h264_high444: { family: 'h264', profile: 'high444p', pix: 'yuv444p', nvencOnly: true },
    h265_main: { family: 'h265', profile: 'main', pix: 'yuv420p' },
    h265_main10: { family: 'h265', profile: 'main10', pix: 'p010le' },
    h265_rext444_8: { family: 'h265', profile: 'rext', pix: 'yuv444p', nvencOnly: true },
    h265_rext444_10: { family: 'h265', profile: 'rext', pix: 'yuv444p16le', nvencOnly: true },
  };
  /** @type {Record<string, string[]>} */
  const upscaleProfileEncoderOptions = {};
  const profileEntries = Object.entries(upscaleProfiles);
  await runPool(profileEntries.length, PROBE_CONCURRENCY, async (i) => {
    const [key, spec] = profileEntries[i];
    const options = [];
    for (const enc of HW_PROFILE_CANDIDATES[spec.family] || []) {
      if (!hwAlive.has(enc) || (spec.nvencOnly && !enc.endsWith('_nvenc'))) continue;
      const args = upscaleProbeArgs(enc, spec.profile, spec.pix, spec.family);
      if (await canEncode(args)) options.push(enc);
    }
    upscaleProfileEncoderOptions[key] = options;
  });
  const webp = listed.has('libwebp') && await canEncode(['-c:v', 'libwebp', '-quality', '80']);

  // Un codec est PROPOSÉ s'il a au moins un chemin qui encode (CPU ou matériel) : le moteur d'export
  // sait déjà retomber GPU→CPU, donc le CPU seul suffit à le rendre utilisable.
  const available = codecs.filter((c) => cpuOk[c] || codecEncoders[c]);
  const pick = (fam) => {
    const hit = available.find((c) => c.startsWith(fam) && codecEncoders[c]);
    return hit ? codecEncoders[hit] : null;
  };
  const h264Encoder = pick('h264_');
  const h265Encoder = pick('h265_');
  const av1Encoder = pick('av1_');

  return {
    codecs: available,
    cpuCodecs: codecs.filter((codec) => cpuOk[codec]),
    codecEncoders,
    codecEncoderOptions,
    upscaleProfileEncoderOptions,
    hwEncoders: [...hwAlive].filter((e) => Object.values(codecEncoderOptions).some((options) => options.includes(e))),
    hasGpuEncoder: !!(h264Encoder || h265Encoder || av1Encoder),
    h264Encoder,
    h265Encoder,
    av1Encoder,
    webp,
    schema: PROBE_SCHEMA,
    signature: ffmpegSignature(),
  };
}

/** @type {Promise<ExportCapabilities>|null} */
let inflight = null;
/** @type {ExportCapabilities|null} */
let memo = null;

/** Cache disque : lecture (null si absent/périmé). @returns {Promise<ExportCapabilities|null>} */
async function readCache() {
  try {
    const raw = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
    if (raw && raw.schema === PROBE_SCHEMA && raw.signature === ffmpegSignature() && Array.isArray(raw.codecs)) return raw;
  } catch (_) { /* pas de cache */ }
  return null;
}

/** Cache disque : écriture best-effort. @param {ExportCapabilities} caps */
async function writeCache(caps) {
  try {
    await fsp.mkdir(NR_HOME, { recursive: true });
    await fsp.writeFile(CACHE_PATH, JSON.stringify(caps, null, 2), 'utf8');
  } catch (_) { /* best-effort */ }
}

/**
 * Capacités d'export de cette machine (mémo process → cache disque → sonde réelle).
 * Les appels concurrents partagent la même sonde en vol (jamais 60 spawns ffmpeg en double).
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<ExportCapabilities>}
 */
async function getCapabilities(opts = {}) {
  if (opts.force) { memo = null; inflight = null; }
  if (memo) return memo;
  if (inflight) return inflight;
  inflight = (async () => {
    if (!opts.force) {
      const cached = await readCache();
      if (cached) { memo = cached; return cached; }
    }
    const caps = await runProbe();
    memo = caps;
    await writeCache(caps);
    return caps;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

module.exports = { getCapabilities, runProbe, PROBE_SCHEMA };
