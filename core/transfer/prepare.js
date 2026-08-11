// @ts-check
// Préparation des médias d'un transfert : liens directs, réencapsulage (remux) ou réencodage.
// Le travail lourd est celui de `core/ae/prepareMedia` ; on lui projette le document et un format
// bâti sur le vocabulaire des PROFILS D'EXPORT (h264_high, prores_422_hq, aac_192…), le même que
// le bouton Télécharger — l'onglet ne réinvente pas une seconde table de codecs.

const { prepareMedia } = require("../ae/prepareMedia");
const { upscaleStep } = require("../ae/upscaleStep");
const { videoEncodeArgs, audioEncodeArgs, containerTagArgs } = require("../export/encodeArgs");
const { pickGpuEncoder } = require("../export/encoder");
const { t } = require("../i18n");

const DEFAULTS = { codec: "prores_422_hq", audio: "copy", container: "mov", speed: "balanced" };

/** Extension d'un fichier AUDIO seul : déduite du codec, aucun réglage à exposer pour ça. */
function audioOnlyExt(audioMode) {
  return audioMode.startsWith("pcm") ? "wav" : "m4a";
}

/** Vrai si le mode audio réencode (donc écrit un fichier), par opposition à la copie de flux. */
function reencodesAudio(audioMode) {
  return audioMode !== "copy" && audioMode !== "none";
}

/** Modes qui écrivent des fichiers sur disque (donc dossier de sortie obligatoire). */
function producesFiles(opts) {
  return opts.mediaMode !== "copy" || reencodesAudio(opts.audio || DEFAULTS.audio);
}

/** @param {import('./types').TransferClip} clip */
function toClipItem(clip) {
  // `prepareMedia` propage les champs inconnus par spread : propriétés natives et animations survivent
  // au remux/réencodage au lieu d'être perdues à la frontière média.
  return { ...clip, fpsClip: clip.fps, xf: clip.xf || null };
}

/** Plan préparé → clip du document : seul le média et ses bornes locales changent. */
function fromPrepared(prepared) {
  const { file, fileInFrame, fpsClip, ...clip } = prepared;
  return {
    ...clip,
    path: file,
    fps: fpsClip,
    // Le fichier produit a sa propre longueur : celle de la source d'origine clamperait à tort.
    srcFrames: 0,
    srcIn: fileInFrame,
    srcOut: fileInFrame + (prepared.srcOut - prepared.srcIn),
  };
}

/** Réachemine la progression de l'export AE sur le canal du transfert. */
function progressBridge(ev) {
  if (!ev || !ev.sender) return null;
  return { sender: { send: (_channel, payload) => ev.sender.send("transfer:progress", payload) } };
}

/**
 * @param {{ run: (bin: string, args: string[]) => Promise<any>, runUpscale?: Function, runTurbo?: Function }} deps
 * @param {any} ev
 * @param {import('./types').TransferDoc} doc
 * @param {{ mediaMode?: 'copy'|'remux'|'reencode', codec?: string, audio?: string, container?: string,
 *           encoderMode?: string, speed?: string, outDir?: string|null, upscale?: any }} opts
 * @returns {Promise<import('./types').TransferDoc | { ok:false, error:string }>}
 */
async function prepareDoc(deps, ev, doc, opts = {}) {
  // L'upscale REMPLACE les pixels : ni la copie ni le réencapsulage ne peuvent le faire. L'option
  // impose donc le réencodage, exactement comme à l'archivage d'une collection.
  const grow = !!(opts.upscale && opts.upscale.enabled);
  const mediaMode = grow ? "reencode" : (opts.mediaMode || "copy");
  const audio = opts.audio || DEFAULTS.audio;
  if (mediaMode === "copy" && !reencodesAudio(audio)) return doc;
  if ((grow || producesFiles({ mediaMode, audio })) && !opts.outDir) {
    return { ok: false, error: t("chooseOutputFolder") };
  }

  const codec = opts.codec || DEFAULTS.codec;
  const container = opts.container || DEFAULTS.container;
  // Moteur matériel réellement sondé sur cette machine, sinon CPU — même résolution que l'export.
  const gpuEncoder = mediaMode === "reencode"
    ? await pickGpuEncoder({ codec, encoderMode: opts.encoderMode })
    : null;

  // `groups` = précompos de timelines imbriquées : le lecteur du transfert aplatit, il n'y en a jamais.
  const edit = { ...doc, items: doc.clips.map(toClipItem), groups: [] };
  const prepared = await prepareMedia(deps, progressBridge(ev), edit, {
    videoMode: mediaMode,
    audio,
    // Même moteur, mêmes réglages qu'ailleurs ; seul le vocabulaire d'encodage est celui des
    // profils d'export, que le moteur accepte tel quel.
    upscale: upscaleStep(opts.upscale, {
      runUpscale: deps.runUpscale ? (args) => deps.runUpscale(ev, args) : undefined,
      runTurbo: deps.runTurbo ? (args) => deps.runTurbo(ev, args) : undefined,
    }, {
      exportCodec: codec, encoderMode: opts.encoderMode, speed: opts.speed || DEFAULTS.speed,
      container, audioMode: audio,
    }, container),
    handleSec: 0,          // un transfert recopie les coupes telles quelles : aucune poignée
    outDir: opts.outDir,
    bake: false,           // la vitesse d'un plan est portée par l'hôte cible, pas cuite dans le fichier
    fps: doc.fps,
    format: {
      ext: container,
      videoArgs: [
        ...videoEncodeArgs(codec, gpuEncoder, opts.speed || DEFAULTS.speed),
        ...containerTagArgs(codec, container),
      ],
      audioArgs: audioEncodeArgs(audio),
      audioOnly: { ext: audioOnlyExt(audio), args: audioEncodeArgs(audio) },
      producesAudio: reencodesAudio(audio),
    },
  });

  return { ...doc, clips: prepared.map(fromPrepared) };
}

module.exports = { prepareDoc };
