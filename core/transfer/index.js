// @ts-check
// Transfert de timeline d'un hôte de montage vers un autre (Resolve ⇄ Premiere ⇄ After Effects).
// Un lecteur et un écrivain par hôte, reliés par le document neutre de `doc.js` : les six couples
// se ramènent à trois lectures et trois écritures, sans pont dédié par paire.

const { listTimelines } = require("../timeline");
const { docFromAdobeSequence, normalizeDoc, docSummary } = require("./doc");
const { readResolveDoc } = require("./readResolve");
const { graftPremiereAnimation, exportSequenceXml, removeQuietly } = require("./premiereXml");
const { importResolveTimeline } = require("./importResolve");
const { appendResolveDoc } = require("./writeResolveAppend");
const { prepareDoc } = require("./prepare");
const { assessTransfer } = require("./equivalence");
const { RESOLVE_FUSION_RUNTIME } = require("./capabilities");
const { transferReport } = require("./lossReport");
const { t } = require("../i18n");

const HOSTS = ["resolve", "ppro", "aeft"];

// Couples SUPPORTÉS. Premiere Pro et After Effects se parlent déjà nativement (Dynamic Link) : un
// transfert par NetsuRush entre ces deux-là n'apporterait rien. After Effects n'est donc qu'une
// destination, et le retour vers Resolve part de Premiere.
const TRANSFER_TARGETS = {
  resolve: ["ppro", "aeft"],
  ppro: ["resolve"],
  aeft: [],
};

/** @param {any} value @returns {value is import('./types').TransferHost} */
function isHost(value) {
  return HOSTS.indexOf(value) >= 0;
}

function isSupportedPair(from, to) {
  return isHost(from) && TRANSFER_TARGETS[from].indexOf(to) >= 0;
}

/**
 * @param {import('./types').TransferRead} read
 * @returns {read is import('./types').TransferDoc}
 */
function isDoc(read) {
  return read.ok === true;
}

function emit(ev, phase, done, total) {
  if (!ev || !ev.sender) return;
  ev.sender.send("transfer:progress", {
    phase, done, total, pct: total > 0 ? Math.round((done * 100) / total) : 0,
  });
}

/**
 * Contrat de la cible pour CE transfert. Resolve n'a aucune API d'image clé, mais l'écrivain sait
 * poser une comp Fusion animée sur les plans concernés : le relevé de capacités le dit, sinon
 * l'aperçu annoncerait une perte que le montage ne subit pas.
 */
function targetCapabilities(target, opts = {}) {
  if (target !== "resolve" || opts.animation === false) return undefined;
  return { runtime: RESOLVE_FUSION_RUNTIME };
}

function transferSummary(doc, target, opts) {
  const fidelity = target ? assessTransfer(doc, target, targetCapabilities(target, opts)) : undefined;
  return { ok: true, timeline: doc.timeline, fps: doc.fps, ...docSummary(doc), missing: doc.missing, mediaLess: doc.mediaLess, fidelity, animation: doc.animation };
}

/** Séquences d'un snapshot Adobe, au format du sélecteur de timelines. */
function adobeSources(snap) {
  if (!snap || !Array.isArray(snap.sequences)) return { ok: false, error: t("snapshotMissing"), timelines: [] };
  const current = snap.activeSequence || null;
  return {
    ok: true,
    current,
    timelines: snap.sequences.map((s) => ({ name: s.name, current: s.name === current })),
  };
}

/**
 * Document → charge utile du job panneau. Les temps de timeline passent en SECONDES : c'est le
 * contrat du pont Adobe (les ticks Premiere sont reconstruits dans host-ppro.jsx), alors que les
 * bornes SOURCE restent en frames, seule forme exacte sur cadence non entière.
 * @param {import('./types').TransferDoc} doc
 */
function adobePayload(doc, opts) {
  const fps = doc.fps || 25;
  const clips = (opts.videoOnly ? doc.clips.filter((c) => c.kind === "video") : doc.clips).map((c) => ({
    path: c.path,
    name: c.name,
    kind: c.kind,
    track: c.track,
    fps: c.fps,
    // L'ancrage se compte en pixels SOURCE : sans ces dimensions, After Effects ne peut pas le poser.
    srcWidth: c.srcWidth,
    srcHeight: c.srcHeight,
    timelineFps: fps,
    inFrame: c.srcIn,
    outFrame: c.srcOut,
    tlStart: c.tlStart / fps,
    tlEnd: c.tlEnd / fps,
    identity: c.identity,
    hostTicks: c.hostTicks,
    video: c.video,
    audio: c.audio,
    timing: c.timing,
    deferred: c.deferred,
  }));
  return {
    name: opts.name || doc.timeline || "NetsuRush",
    mode: opts.mode === "append" ? "append" : "new",
    timelineName: opts.target || undefined,
    fps,
    width: doc.width,
    height: doc.height,
    duration: doc.endFrame / fps,
    videoOnly: !!opts.videoOnly,
    clips,
  };
}

/**
 * Un plan porte TOUJOURS ses composants intrinsèques : le panneau qui n'en lit aucun signale une
 * lecture muette, pas une timeline sans effet. On le dit une fois, avec ce que la collection
 * contenait vraiment — sans ce relevé, « rien d'animé » et « rien lu » se ressemblent trop.
 */
function logSilentComponents(snap, name) {
  const wanted = name || (snap && snap.activeSequence) || "";
  const sequence = snap && Array.isArray(snap.sequences)
    ? snap.sequences.find((s) => s && s.name === wanted) || snap.sequences[0]
    : null;
  const clips = (sequence && sequence.tracks || []).flatMap((track) => (track && track.clips) || []);
  const silent = clips.filter((clip) => clip && clip.components);
  if (!silent.length || silent.length !== clips.length) return;
  console.warn("[transfer] aucun composant lu chez Premiere ; l'animation vient de l'export XML. Vu :",
    JSON.stringify(silent[0].components));
}

/**
 * Éléments sans média du document, avec le relevé que l'hôte en a donné. Un titre dont on n'a pas
 * su lire le texte et un cache de couleur se ressemblent dans l'interface ; seul ce relevé les
 * distingue, et il est resté invisible tant qu'il ne vivait que dans l'aperçu.
 */
function logMediaLess(doc) {
  const items = doc.mediaLess || [];
  const graphics = doc.graphics || [];
  if (!items.length && !graphics.length) return;
  console.log(`[transfer] titres lus : ${graphics.length}`
    + (graphics.length ? ` (${graphics.map((g) => JSON.stringify(g.text)).join(", ")})` : "")
    + ` · sans média : ${items.length}${items.length ? ` → ${items.join(" | ")}` : ""}`);
}

/** Le document porte-t-il déjà des images clés ? Alors la source les a rendues, l'export est inutile. */
function hasKeyframes(doc) {
  const animated = (property) => !!(property && Array.isArray(property.keyframes) && property.keyframes.length);
  return doc.clips.some((clip) => {
    const transform = (clip.video && clip.video.transform) || {};
    const audio = clip.audio || {};
    return [
      transform.position, transform.scale, transform.anchor, transform.rotation, transform.opacity,
      audio.gainDb, audio.volume, audio.pan, audio.mute,
    ].some(animated);
  });
}

function createTransfer({ getResolve, adobeBridge, aeExporter, runFfmpeg, ev: sseEvent }) {
  /**
   * Accès à l'hôte Premiere pour la lecture d'animation. `ev` est le shim SSE partagé du core :
   * la lecture n'a pas d'événement propre, mais le job panneau passe par le même canal diffusé.
   */
  function premiereHost() {
    return {
      exportXml: (filePath, timelineName) => adobeBridge.exportXml(sseEvent, "ppro", filePath, timelineName),
    };
  }

  /** Timelines / séquences / compositions disponibles sur un hôte. */
  async function listSources(opts = {}) {
    const host = opts.host;
    if (host === "resolve") return listTimelines();
    if (!isHost(host)) return { ok: false, error: t("unknownApp"), timelines: [] };
    return adobeSources(adobeBridge.snapshot(host));
  }

  /**
   * Lit une timeline en document d'échange. C'est aussi ce que l'aperçu affiche AVANT le montage.
   * @returns {Promise<import('./types').TransferRead>}
   */
  async function readDoc(opts = {}) {
    const host = opts.host;
    if (host === "resolve") {
      const resolve = await getResolve();
      if (!resolve) return { ok: false, error: t("resolveUnavailable") };
      return readResolveDoc(resolve, opts.timelineName || null);
    }
    if (!isHost(host)) return { ok: false, error: t("unknownApp") };
    const read = docFromAdobeSequence(adobeBridge.snapshot(host), opts.timelineName || "");
    // Le mappeur reste pur : il rend une CLÉ de message, traduite ici.
    if (read.ok !== true) return { ok: false, error: t(read.error) };
    const doc = normalizeDoc(read);
    if (host !== "ppro" || opts.animation === false) return doc;
    logSilentComponents(adobeBridge.snapshot(host), opts.timelineName || "");
    logMediaLess(doc);
    // Le panneau a déjà lu les courbes : l'export XML n'apporterait rien et coûterait un
    // aller-retour à l'hôte. Il ne sert que lorsque les composants sont restés muets.
    if (hasKeyframes(doc)) return doc;
    const grafted = await graftPremiereAnimation(premiereHost(), doc, opts.timelineName || null);
    return { ...grafted.doc, animation: grafted.animation };
  }

  /** Aperçu chiffré d'une timeline (plans, pistes, durée, sources manquantes). */
  async function summary(opts = {}) {
    const read = await readDoc(opts);
    if (!isDoc(read)) return read;
    const target = isHost(opts.to) ? opts.to : null;
    return transferSummary(read, target, opts);
  }

  /**
   * L'import natif est-il la bonne voie ? Il applique lui-même les images clés, les niveaux audio
   * et la vitesse — mais il crée TOUJOURS une timeline neuve et suit les chemins écrits dans le
   * XML. Un ajout à une timeline existante ou des médias que NetsuRush vient de produire retombent
   * donc sur la pose par l'API, seule capable de viser une timeline et des fichiers choisis.
   */
  function canImportNatively(from, opts) {
    return from === "ppro"
      && opts.mode !== "append"
      && !opts.target
      && (!opts.mediaMode || opts.mediaMode === "copy")
      && opts.vehicle !== "api";
  }

  /**
   * Écriture dans Resolve. L'import du fichier d'échange d'abord, la pose plan par plan ensuite :
   * un import qui échoue ne doit pas coûter le transfert, et la pose est de toute façon la seule
   * voie pour les cas que l'import ne couvre pas.
   */
  async function writeResolve(ev, doc, opts) {
    const byApi = () => appendResolveDoc(doc, {
      name: opts.name, mode: opts.mode, timelineName: opts.target,
      videoOnly: opts.videoOnly, animation: opts.animation,
      onProgress: (p) => emit(ev, p.phase, p.done, p.total),
    });
    if (!canImportNatively(opts.from, opts)) return byApi();

    emit(ev, "import", 0, 1);
    const exported = await exportSequenceXml(premiereHost(), opts.timelineName || null);
    if (exported.ok !== true) {
      console.warn("[transfer] export d'échange indisponible, pose par l'API :", exported.reason);
      return byApi();
    }
    let result;
    try {
      result = await importResolveTimeline(exported.path, doc, { name: opts.name });
    } catch (error) {
      await removeQuietly(exported.path);
      throw error;
    }
    emit(ev, "import", 1, 1);
    if (result.ok) {
      await removeQuietly(exported.path);
      return result;
    }
    // Le fichier SURVIT à un refus, et son chemin remonte jusqu'à l'interface : l'import manuel
    // donne un résultat que la pose par script ne peut pas atteindre — l'API n'écrit aucun niveau
    // audio ni la moindre image clé. Un refus reste donc rattrapable à la main.
    console.warn("[transfer] import refusé par Resolve, pose par l'API :", result.error);
    console.warn("[transfer] fichier d'échange conservé (Fichier ▸ Importer ▸ Timeline) :", exported.path);
    const fallback = await byApi();
    return { ...fallback, exchangeFile: exported.path };
  }

  /**
   * Transfère une timeline vers l'hôte cible.
   * @param {{ from?:string, to?:string, timelineName?:string, name?:string, mode?:'new'|'append',
   *           target?:string, videoOnly?:boolean, ae?:object,
   *           mediaMode?:'copy'|'remux'|'reencode', codec?:string, audio?:string, container?:string,
   *           encoderMode?:string, speed?:string, outDir?:string|null, animation?:boolean }} [opts]
   */
  async function run(ev, opts = {}) {
    const { from, to } = opts;
    if (!isHost(from) || !isHost(to)) return { ok: false, error: t("unknownApp") };
    if (from === to) return { ok: false, error: t("sameHost") };
    if (!isSupportedPair(from, to)) return { ok: false, error: t("pairUnsupported") };

    // Resolve → After Effects avec options avancées : le pipeline dédié (transforms, retime,
    // précompositions, transcodes) va plus loin qu'une recopie de plans, on le laisse conduire.
    // Son résultat est ramené à la forme du transfert, sinon l'écran de fin lirait des champs vides.
    if (from === "resolve" && to === "aeft" && opts.ae) {
      const source = await readDoc({ host: from, timelineName: opts.timelineName });
      if (!isDoc(source)) return source;
      const ae = await aeExporter.aeExport(ev, { ...opts.ae, timelineName: opts.timelineName || null });
      const result = {
        ok: ae.ok, timeline: ae.comp, count: ae.clips, created: true,
        from, to, source: source.timeline, missing: ae.missing, error: ae.error,
      };
      return { ...result, fidelity: transferReport(assessTransfer(source, to, targetCapabilities(to, opts)), result) };
    }

    emit(ev, "read", 0, 1);
    const read = await readDoc({ host: from, timelineName: opts.timelineName });
    if (!isDoc(read)) return read;
    if (!read.clips.length) return { ok: false, error: t("noTransferClips"), missing: read.missing };
    emit(ev, "read", 1, 1);

    // Liens directs, réencapsulage ou réencodage : le document repart avec les fichiers produits.
    const prepared = await prepareDoc({ run: runFfmpeg }, ev, read, opts);
    if (!isDoc(prepared)) return prepared;
    const doc = prepared;

    const assessment = assessTransfer(doc, to, targetCapabilities(to, opts));
    const result = to === "resolve"
      ? await writeResolve(ev, doc, opts)
      : await adobeBridge.placeTimeline(ev, to, adobePayload(doc, opts));

    emit(ev, "done", 1, 1);
    return {
      ...result,
      from,
      to,
      source: doc.timeline,
      missing: result.missing || doc.missing,
      mediaLess: doc.mediaLess,
      fidelity: transferReport(assessment, result),
    };
  }

  return { listSources, readDoc, summary, run };
}

module.exports = { createTransfer, adobePayload, adobeSources, transferSummary, isSupportedPair, HOSTS, TRANSFER_TARGETS };
