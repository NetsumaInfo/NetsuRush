// @ts-check
// Moteur d'export fichier piloté par un PROFIL. Deux flux :
//  - video_remux : copie de flux lossless (`-c copy`), fallback ré-encode si la copie échoue ;
//  - video_encode : ré-encodage codec/audio. Moteur GPU/NVENC/AMF/QSV/CPU choisi par profil,
//    limité aux encodeurs réellement sondés ; repli CPU si le moteur matériel échoue à l'ouverture.
// Per-clip (un fichier par plan) OU fusion (merge → concat demuxer, un seul fichier).
// Travaille en SECONDES (start/end) comme exportClip — ne touche pas la frame-math timeline.
// Progression émise sur le canal SSE `export:progress` (compteur per-clip).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const ffmpeg = require('./ffmpeg');
const { sanitizeName } = require('./utils');
const naming = require('./export/naming');
const spacer = require('./export/spacer');
const { videoEncodeArgs, audioEncodeArgs, audioMapArgs, mergeMapArgs, containerTagArgs } = require('./export/encodeArgs');
const { pickGpuEncoder } = require('./export/encoder');
const encodeGate = require('./export/gate');
const capabilities = require('./export/capabilities');
const audioLang = require('./audioLang');
const { t } = require('./i18n');

/**
 * @typedef {object} AudioSelectLike
 * @property {string} mode  'auto' | 'language' | 'track'
 * @property {string} [language]  code de langue cible (mode 'language')
 * @property {number} [track]     index de piste a:N (mode 'track')
 */

/**
 * @typedef {object} ExportProfileLike
 * @property {string} workflow @property {string} codec @property {string} audioMode @property {string} container
 * @property {string} [encoderMode] @property {string} [speed] @property {string} [name] @property {string} [naming]
 * @property {number} [mergeGap]  noir intercalé entre les plans en fusion (millisecondes ; 0 = aucun)
 * @property {AudioSelectLike} [audioSelect]
 */

/** @typedef {{ input: string, start: number, end: number, label?: string, audioTrack?: number|null }} ExportClipInput */

/**
 * Résout, POUR CHAQUE plan, quelle piste audio garder selon `profile.audioSelect` (mute la liste
 * `clips` en place → `clip.audioTrack`). Trois modes :
 *  - 'auto' (« Aucun ») → ne touche à rien (comportement historique : piste explicite du Derush, sinon
 *                       toutes les pistes via 0:a?) ;
 *  - 'track'          → force une piste précise par numéro (a:N) ;
 *  - 'language'       → choisit la piste de la langue cible. Métadonnées d'abord (tag/titre, cf.
 *                       audioLang) ; si aucune étiquetée ne correspond ET `detectLang` fourni, devine
 *                       à l'oreille (IA) les pistes NON étiquetées. Échec → toutes les pistes (jamais
 *                       de vidéo muette silencieuse). Une piste choisie explicitement dans le Derush
 *                       l'emporte toujours (jamais écrasée).
 * @param {ExportClipInput[]} clips @param {ExportProfileLike} profile
 * @param {{ detectLang?: (input: string, track: number) => Promise<string|null> }} [deps]
 */
async function resolveClipAudio(clips, profile, deps = {}) {
  const sel = profile && profile.audioSelect;
  const mode = sel && sel.mode;
  if (!mode || mode === 'auto') return;
  if (mode === 'track') {
    const idx = Math.round(Number(sel.track));
    if (!Number.isFinite(idx) || idx < 0) return;
    for (const c of clips) if (c.audioTrack == null) c.audioTrack = idx;
    return;
  }
  if (mode !== 'language') return;
  const code = audioLang.normalizeLang(sel.language) || (sel.language || null);
  if (!code) return;
  const detectLang = deps.detectLang || null;
  const cache = new Map(); // input → index résolu (une source sert souvent plusieurs plans)
  for (const c of clips) {
    if (c.audioTrack != null && c.audioTrack >= 0) continue; // choix explicite du Derush → intact
    if (!cache.has(c.input)) cache.set(c.input, await resolveInputTrack(c.input, code, detectLang));
    const idx = cache.get(c.input);
    if (idx != null && idx >= 0) c.audioTrack = idx;
  }
}

/**
 * Index (a:N) de la piste de langue `code` d'un fichier, ou null (→ garder toutes les pistes).
 * @param {string} input @param {string} code
 * @param {((input: string, track: number) => Promise<string|null>)|null} detectLang
 * @returns {Promise<number|null>}
 */
async function resolveInputTrack(input, code, detectLang) {
  let tracks = [];
  try { tracks = (await ffmpeg.probeAudioTracks(input)).tracks || []; } catch (_) { return null; }
  if (!tracks.length) return null;
  const meta = audioLang.pickTrackByLanguage(tracks, code);
  if (meta >= 0) return meta;
  if (detectLang) { // secours IA silencieux : deviner les pistes SANS étiquette
    for (const t of tracks) {
      if (audioLang.trackLangCode(t)) continue; // déjà étiquetée (et non concordante) → ne pas deviner
      let guess = null;
      try { guess = audioLang.normalizeLang(await detectLang(input, t.index)); } catch (_) { guess = null; }
      if (guess === code) return t.index;
    }
  }
  return null;
}

/**
 * Pool concurrentiel : lance `worker(i)` pour i∈[0,count[ avec au plus `conc` en vol. Sert l'export
 * PARALLÈLE (plusieurs plans encodés à la fois). L'ordre d'achèvement est libre → l'appelant écrit dans
 * un tableau indexé (pas de course).
 * @param {number} count @param {number} conc @param {(i: number) => Promise<void>} worker
 */
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

/**
 * Nombre d'encodes simultanés. Remux (copie) = IO → 4 ; encode GPU = 3 (sessions NVENC + chevauchement
 * du décodage) ; encode CPU = 2 (chaque ffmpeg est déjà multi-thread → éviter la surcharge). Override
 * possible via opts.concurrency.
 * @param {ExportProfileLike} profile @param {string|null} gpuEncoder @param {number} total @param {number} [override]
 */
function exportConcurrency(profile, gpuEncoder, total, override) {
  if (override && override > 0) return Math.min(override, total);
  if (profile.workflow !== 'video_encode') return Math.min(4, total);
  return Math.min(gpuEncoder ? 3 : 2, total);
}

/** @param {string} ext @returns {boolean} */
const isFaststart = (ext) => ext === 'mp4' || ext === 'mov';

/** Vrai si l'erreur ffmpeg vient de l'ouverture d'un encodeur matériel (→ repli CPU). */
function isEncoderOpenError(err) {
  const s = String((err && err.stderr) || err || '').toLowerCase();
  return /nvenc|openencodesessionex|cannot load|encoder|hardware|device/.test(s)
    && /(fail|error|not found|no capable|unsupported|invalid)/.test(s);
}

/**
 * Args ffmpeg pour produire UN fichier de sortie depuis un plan.
 * @param {ExportClipInput} clip @param {string} out @param {ExportProfileLike} profile
 * @param {string|null} gpuEncoder @param {boolean} encode @returns {string[]}
 */
function clipArgs(clip, out, profile, gpuEncoder, encode) {
  const base = ['-y', '-ss', String(clip.start), '-i', clip.input, '-t', String(clip.end - clip.start)];
  const map = audioMapArgs(clip.audioTrack, profile.audioMode);
  if (!encode) return [...base, ...map, '-c', 'copy', '-avoid_negative_ts', 'make_zero', out];
  const ext = profile.container;
  const args = [
    ...base,
    ...map,
    ...videoEncodeArgs(profile.codec, gpuEncoder, profile.speed),
    ...audioEncodeArgs(profile.audioMode),
    ...containerTagArgs(profile.codec, ext),
  ];
  if (isFaststart(ext)) args.push('-movflags', '+faststart');
  args.push('-max_muxing_queue_size', '1024', out);
  return args;
}

/**
 * Encode/copie UN plan vers `out`, avec replis : remux→ré-encode, GPU→CPU.
 * @param {ExportClipInput} clip @param {string} out @param {ExportProfileLike} profile
 * @param {string|null} gpuEncoder @returns {Promise<void>}
 */
async function runClip(clip, out, profile, gpuEncoder) {
  const encode = profile.workflow === 'video_encode';
  try {
    await ffmpeg.run('ffmpeg', clipArgs(clip, out, profile, gpuEncoder, encode));
  } catch (e) {
    if (encode && gpuEncoder && isEncoderOpenError(e) && (!profile.encoderMode || profile.encoderMode === 'auto')) {
      await ffmpeg.run('ffmpeg', clipArgs(clip, out, profile, null, true)); // anciens profils : repli CPU
    } else if (!encode) {
      await ffmpeg.run('ffmpeg', clipArgs(clip, out, profile, gpuEncoder, true)); // remux échoué → ré-encode
    } else {
      throw e;
    }
  }
}

/**
 * Export principal. Per-clip (un fichier/plan) ou fusion (un seul fichier via concat).
 * @param {{ sender?: { send: (ch: string, p: any) => void } }} event
 * @param {{ clips: ExportClipInput[], dir?: string, savePath?: string, savePaths?: (string|null)[],
 *           baseName?: string, profile: ExportProfileLike, merge?: boolean, concurrency?: number,
 *           jobId?: string, detectLang?: (input: string, track: number) => Promise<string|null> }} opts
 * @returns {Promise<{ ok: boolean, files: string[], outs?: (string|null)[], failed: number, error?: string }>}
 */
async function exportClips(event, opts) {
  const { clips, profile, merge } = opts || {};
  if (!Array.isArray(clips) || !clips.length) return { ok: false, files: [], failed: 0, error: t('noShotsExport') };
  if (!profile) return { ok: false, files: [], failed: 0, error: t('exportProfileMissing') };

  // Sélection intelligente de piste audio par langue (profile.audioSelect) — mute clips[].audioTrack.
  await resolveClipAudio(clips, profile, { detectLang: opts.detectLang });

  const ext = profile.container || 'mp4';
  const base = sanitizeName(opts.baseName || 'export') || 'export';
  const phase = profile.workflow === 'video_encode' ? 'Encode' : 'Découpe';
  const total = clips.length;
  const gpuEncoder = await pickGpuEncoder(profile);

  // Horloge UNIQUE du lot : les jetons {date}/{time} doivent donner la même valeur pour tous les
  // plans, sinon un export à cheval sur une seconde sort des noms qui ne se rangent plus ensemble.
  const now = new Date();
  if (merge && total > 1) return mergeExport(event, opts, { ext, base, gpuEncoder, profile, now });

  const dir = opts.dir || '';
  // Noms planifiés AVANT le pool (ordre d'index stable, réservation anti-collision). Sautés quand
  // l'appelant impose déjà toutes les destinations (archivage d'une collection, sortie unique).
  const imposed = total === 1 && opts.savePath
    ? [opts.savePath]
    : (opts.savePaths && opts.savePaths.length >= total && opts.savePaths.every((p) => p) ? opts.savePaths : null);
  const planned = imposed || naming.planOutputs(clips, {
    dir, ext, template: profile.naming, base, profile: profile.name,
    codec: profile.workflow === 'video_encode' ? profile.codec : 'copy',
    now, exists: fs.existsSync,
  });
  /** @type {(string|null)[]} */
  const outs = new Array(total).fill(null);
  const errors = [];
  let done = 0;

  // Export PARALLÈLE (pool concurrentiel) : les plans s'encodent à plusieurs à la fois. Résultats
  // écrits dans un tableau indexé → l'ordre des fichiers reste stable malgré l'achèvement libre.
  // Chaque encode passe par le PORTAIL GLOBAL : plusieurs exports simultanés (rendu en lot) ne
  // dépassent jamais ensemble la limite de la machine.
  const conc = exportConcurrency(profile, gpuEncoder, total, opts.concurrency);
  const slot = encodeGate.register(conc);
  try {
    await runPool(total, conc, async (i) => {
      // `savePaths` = destination IMPOSÉE par plan (archivage d'une collection : chaque fichier doit
      // retomber sur le nom attendu à son index). Sans elle, le nom vient du gabarit du profil
      // (cf. export/naming.js), planifié plus haut pour tout le lot.
      const out = (opts.savePaths && opts.savePaths[i]) || planned[i];
      try {
        await encodeGate.withSlot(() => runClip(clips[i], out, profile, gpuEncoder));
        outs[i] = out;
      } catch (e) {
        errors.push(`plan ${i + 1}: ${String((e && e.stderr) || e).split('\n').slice(-2).join(' ').slice(-200)}`);
      }
      done++;
      if (event && event.sender) {
        event.sender.send('export:progress', { jobId: opts.jobId, file: path.basename(out), done, total, pct: Math.round((done / total) * 100), phase });
      }
    });
  } finally {
    slot.release();
  }

  const files = outs.filter((f) => f != null);
  // `outs` (indexé sur clips, null = échec) en plus de `files` (filtré) : l'archivage des collections
  // le persiste pour savoir quel fichier appartient à quel plan lors d'un changement de dossier.
  return { ok: files.length > 0, files, outs, failed: total - files.length, error: files.length ? undefined : errors[0] || t('exportFailed') };
}

/**
 * Nom du fichier FUSIONNÉ. Le gabarit y est résolu SANS index (un seul fichier pour tout le lot) et
 * la durée annoncée est la SOMME des plans — c'est la longueur du fichier produit, pas l'écart entre
 * la première et la dernière borne, qui n'a aucun sens dès que les plans viennent de sources
 * différentes.
 * @param {ExportClipInput[]} clips @param {string} dir @param {string} ext @param {string} base
 * @param {ExportProfileLike} profile @param {Date} [now] @returns {string}
 */
function mergeOutputPath(clips, dir, ext, base, profile, now) {
  const first = clips[0];
  const last = clips[clips.length - 1];
  const stem = naming.resolveName(profile.naming, {
    base,
    source: first.input,
    index: null,
    total: clips.length,
    start: first.start,
    end: last.end,
    duration: clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0),
    profile: profile.name,
    codec: profile.workflow === 'video_encode' ? profile.codec : 'copy',
    container: ext,
    now,
  });
  return naming.uniqueOutput(dir, stem, ext, { taken: new Set(), exists: fs.existsSync });
}

/**
 * Fabrique le morceau de noir intercalé entre les plans, aux paramètres RÉELS du premier morceau
 * produit (dimensions, cadence, codec/fréquence/canaux audio) — c'est ce qui permet à la
 * concaténation de rester en copie de flux. Rend `null` quand le profil n'en demande pas.
 *
 * Un échec n'interrompt PAS la fusion : le montage sort sans séparation, ce qui reste le résultat
 * attendu à un détail cosmétique près, là où propager l'erreur perdrait tout le travail d'encodage.
 * @param {string} work @param {string} firstPart @param {string} ext
 * @param {ExportProfileLike} profile @param {string|null} gpuEncoder
 * @returns {Promise<string|null>}
 */
async function buildSpacer(work, firstPart, ext, profile, gpuEncoder) {
  const seconds = Math.max(0, Number(profile.mergeGap) || 0) / 1000;
  if (!seconds) return null;
  const out = path.join(work, `spacer.${ext}`);
  try {
    const [meta, play, audio] = await Promise.all([
      ffmpeg.probeMedia(firstPart), ffmpeg.playInfo(firstPart), ffmpeg.probeAudioTracks(firstPart),
    ]);
    const track = (audio.tracks || [])[0] || null;
    await ffmpeg.run('ffmpeg', spacer.spacerArgs({
      seconds,
      width: meta.width,
      height: meta.height,
      fps: play.fps,
      // Pas de piste dans les plans ⇒ pas de piste dans le noir : la concaténation compare les flux
      // un à un, un silence en trop y ferait échouer la copie.
      audio: track ? { codec: track.codec, channels: track.channels, sampleRate: track.sampleRate } : null,
      audioMode: profile.audioMode,
      videoArgs: videoEncodeArgs(profile.codec, gpuEncoder, profile.speed),
      audioArgs: audioEncodeArgs(profile.audioMode),
      tagArgs: containerTagArgs(profile.codec, ext),
      out,
    }));
    return out;
  } catch (e) {
    // La console du core est branchée sur le journal (logbus) → le repli est TRACÉ, jamais muet.
    console.warn('export: séparateur de fusion non produit, montage sans noir intercalé —',
      String((e && e.stderr) || e).split('\n').pop());
    return null;
  }
}

/**
 * Fusion : coupe chaque plan en temp puis concat demuxer (copy, fallback ré-encode) → 1 fichier.
 * @param {{ sender?: { send: (ch: string, p: any) => void } }} event
 * @param {{ clips: ExportClipInput[], dir?: string, savePath?: string, concurrency?: number, jobId?: string }} opts
 * @param {{ ext: string, base: string, gpuEncoder: string|null, profile: ExportProfileLike, now?: Date }} ctx
 * @returns {Promise<{ ok: boolean, files: string[], failed: number, error?: string }>}
 */
async function mergeExport(event, opts, ctx) {
  const { clips } = opts;
  const { ext, base, gpuEncoder, profile } = ctx;
  const total = clips.length;
  const out = opts.savePath || mergeOutputPath(clips, opts.dir || '', ext, base, profile, ctx.now);
  const send = (pct) => { if (event && event.sender) event.sender.send('export:progress', { jobId: opts.jobId, file: path.basename(out), done: 0, total, pct, phase: 'Fusion' }); };

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'netsurush-export-'));
  try {
    // Parts encodées EN PARALLÈLE (pool), écrites dans un tableau indexé → l'ordre du concat est préservé.
    /** @type {string[]} */
    const parts = new Array(total);
    let done = 0;
    const conc = exportConcurrency(profile, gpuEncoder, total, opts.concurrency);
    const slot = encodeGate.register(conc);
    try {
      await runPool(total, conc, async (i) => {
        const part = path.join(work, `part_${String(i + 1).padStart(3, '0')}.${ext}`);
        await encodeGate.withSlot(() => runClip(clips[i], part, profile, gpuEncoder));
        parts[i] = part;
        done++;
        send(Math.round((done / total) * 80));
      });
    } finally {
      slot.release();
    }
    // Noir de séparation entre les plans (réglage du profil). Fabriqué APRÈS les plans : il se cale
    // sur les paramètres réels du premier morceau, seule façon de rester en copie de flux.
    const spacerFile = await buildSpacer(work, parts[0], ext, profile, gpuEncoder);
    const listPath = path.join(work, 'concat.txt');
    const listBody = spacer.interleave(parts, spacerFile)
      .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    await fsp.writeFile(listPath, listBody, 'utf8');
    send(90);

    const concatBase = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath];
    const map = mergeMapArgs(profile.audioMode);
    const tail = isFaststart(ext) ? ['-movflags', '+faststart', out] : [out];
    await encodeGate.withSlot(async () => {
      try {
        await ffmpeg.run('ffmpeg', [...concatBase, ...map, '-c', 'copy', ...containerTagArgs(profile.codec, ext), ...tail]);
      } catch (_) {
        await ffmpeg.run('ffmpeg', [
          ...concatBase,
          ...map,
          ...videoEncodeArgs(profile.codec, gpuEncoder, profile.speed),
          ...audioEncodeArgs(profile.audioMode),
          ...containerTagArgs(profile.codec, ext),
          ...tail,
        ]);
      }
    });
    send(100);
    return { ok: true, files: [out], failed: 0 };
  } catch (e) {
    return { ok: false, files: [], failed: total, error: String((e && e.stderr) || e).split('\n').slice(-2).join(' ').slice(-200) };
  } finally {
    try { await fsp.rm(work, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

/**
 * Capacités d'export de cette machine (codecs réellement encodables), pour le renderer : ce qu'il ne
 * peut pas exécuter n'est pas proposé. Sondé une fois puis caché sur disque.
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, codecs: string[], cpuCodecs: string[], hasGpuEncoder: boolean, hwEncoders: string[], codecEncoderOptions: Record<string, string[]>, error?: string }>}
 */
async function exportCapabilities(opts = {}) {
  try {
    const caps = await capabilities.getCapabilities({ force: !!opts.force });
    return {
      ok: true,
      codecs: caps.codecs,
      cpuCodecs: caps.cpuCodecs || [],
      hasGpuEncoder: caps.hasGpuEncoder,
      hwEncoders: caps.hwEncoders || [],
      codecEncoderOptions: caps.codecEncoderOptions || {},
    };
  } catch (e) {
    // Sonde en échec : ne RIEN masquer (le renderer garde sa liste complète) plutôt que de priver
    // l'utilisateur de tous ses codecs sur une erreur transitoire.
    return { ok: false, codecs: [], cpuCodecs: [], hasGpuEncoder: false, hwEncoders: [], codecEncoderOptions: {}, error: String((e && e.message) || e) };
  }
}

// Plan FICTIF de l'aperçu de nommage : des valeurs qui exercent tous les jetons (une source nommée,
// des bornes non rondes, un lot de plusieurs plans) sans toucher au disque.
const PREVIEW_CLIP = { input: 'rush-01.mkv', start: 12.34, end: 18.5, label: 'plan' };
const PREVIEW_TOTAL = 3;

/**
 * Nom que produirait le profil, pour l'éditeur — la MÊME résolution que l'export réel, donc l'aperçu
 * ne peut pas mentir. Rend aussi le nom du fichier fusionné (le gabarit s'y résout sans index) et la
 * liste des jetons, qui peuple le menu « Insérer » : un jeton ajouté au core apparaît dans l'UI.
 * @param {{ profile: ExportProfileLike, baseName?: string }} opts
 * @returns {{ name: string, merged: string, tokens: string[] }}
 */
function previewName(opts) {
  const profile = (opts && opts.profile) || /** @type {ExportProfileLike} */ ({});
  const ext = profile.container || 'mp4';
  const base = sanitizeName(opts.baseName || 'export') || 'export';
  const ctx = {
    base,
    source: PREVIEW_CLIP.input,
    total: PREVIEW_TOTAL,
    start: PREVIEW_CLIP.start,
    end: PREVIEW_CLIP.end,
    label: PREVIEW_CLIP.label,
    profile: profile.name,
    codec: profile.workflow === 'video_encode' ? profile.codec : 'copy',
    container: ext,
  };
  return {
    name: `${naming.resolveName(profile.naming, { ...ctx, index: 1 })}.${ext}`,
    merged: `${naming.resolveName(profile.naming, { ...ctx, index: null })}.${ext}`,
    tokens: naming.NAMING_TOKENS,
  };
}

module.exports = { exportClips, exportCapabilities, previewName };
