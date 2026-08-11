// @ts-check
// Transfert de timeline d'un hôte de montage vers un autre (Resolve ⇄ Premiere ⇄ After Effects).
// Un lecteur et un écrivain par hôte, reliés par le document neutre de `doc.js` : les six couples
// se ramènent à trois lectures et trois écritures, sans pont dédié par paire.

const { listTimelines } = require("../timeline");
const { docFromAdobeSequence, normalizeDoc, docSummary } = require("./doc");
const { readResolveDoc, exportResolveTimelineXml } = require("./readResolve");
const { graftPremiereAnimation, exportSequenceXml, removeQuietly } = require("./premiereXml");
const { importResolveTimeline } = require("./importResolve");
const { appendResolveDoc } = require("./writeResolveAppend");
const { prepareDoc } = require("./prepare");
const { prepareForPremiere } = require("./xmeml/premiereText");
const { assessTransfer } = require("./equivalence");
const { RESOLVE_FUSION_RUNTIME } = require("./capabilities");
const { transferReport } = require("./lossReport");
const fsp = require("fs/promises");
const path = require("path");
const fs = require("fs");
const { panelSourceDir } = require("../adobePanel");
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
  // Les titres voyagent À PART des plans : ils n'ont ni fichier ni bornes source, et la cible les
  // recrée depuis un modèle. Temps en secondes, comme les plans (contrat du pont Adobe).
  const graphics = (doc.graphics || []).map((g) => ({
    track: g.track,
    name: g.name,
    text: g.text,
    font: g.font,
    size: g.size,
    tlStart: g.tlStart / fps,
    tlEnd: g.tlEnd / fps,
  }));
  return {
    name: opts.name || doc.timeline || "NetsuRush",
    mode: opts.mode === "append" ? "append" : "new",
    timelineName: opts.target || undefined,
    graphics,
    mogrt: opts.mogrt || undefined,
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

/**
 * Journalise CE QUI S'EST PERDU, propriété par propriété. L'écran de fin ne montre que des compteurs :
 * « 12 appliquées, 3 problèmes » ne dit ni quelle propriété ni pourquoi, alors que le writer, lui,
 * rend un motif par item (paramètre introuvable, relecture indisponible, valeur relue différente).
 * Sans cette trace, diagnostiquer une animation manquante demandait de rejouer le transfert à la main.
 */
function logFidelityLosses(fidelity) {
  const items = (fidelity && fidelity.items) || [];
  const lost = items.filter((item) => item && item.status !== "applied");
  if (!lost.length) return;
  console.warn("[transfer] fidélité :", JSON.stringify(fidelity.actual));
  for (const item of lost.slice(0, 60)) {
    console.warn(`[transfer]   plan ${item.clip} ${item.property} ${item.status}${item.reason ? " (" + item.reason + ")" : ""}`);
  }
  if (lost.length > 60) console.warn(`[transfer]   … ${lost.length - 60} autres`);
}

/**
 * Modèle de titre livré avec le panneau. Aucune API Premiere ne crée un titre à partir de rien :
 * `importMGT` pose un vrai graphique essentiel depuis ce `.mogrt`, dont on ne remplace que le texte
 * — le style vient du modèle. Absent, les titres sont déclarés perdus plutôt que fabriqués de
 * travers (l'import du générateur FCP7 hérité rendait un corps et un multi-ligne faux).
 */
function titleTemplatePath() {
  try {
    const file = path.join(panelSourceDir(), "assets", "netsurush-title.mogrt");
    return fs.existsSync(file) ? file : null;
  } catch (_) {
    return null;
  }
}

/**
 * L'import natif VERS PREMIERE se DEMANDE, il n'est plus la voie par défaut. Il applique bien
 * lui-même images clés et vitesse, mais trois défauts mesurés le disqualifient comme défaut :
 * l'importeur crée SES PROPRES éléments de projet — les mêmes rushs réapparaissent en double, et
 * aucune API ne rebranche après coup un plan de séquence sur un élément existant — et le titre qu'il
 * pose est un générateur FCP7 hérité, dont ni le corps ni le multi-ligne ne suivent. La pose par
 * script fait mieux sur les trois depuis qu'elle sait poser un titre par `.mogrt`.
 *
 * Il reste offert (`vehicle: "import"`) : c'est la seule voie qui rende un montage entier sans que
 * NetsuRush n'écrive quoi que ce soit, donc le recours quand une écriture par script déçoit.
 */
function canImportToPremiere(from, opts) {
  return from === "resolve"
    && opts.vehicle === "import"
    && opts.mode !== "append"
    && !opts.target
    && !opts.videoOnly
    && (!opts.mediaMode || opts.mediaMode === "copy");
}


function createTransfer({ getResolve, adobeBridge, aeExporter, runFfmpeg, runUpscale, runTurbo, ev: sseEvent }) {
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
   * Écriture dans Premiere. L'import du fichier d'échange d'abord, la pose plan par plan ensuite :
   * un import refusé ne doit pas coûter le transfert.
   */
  async function writePremiere(ev, doc, opts) {
    // Le modèle de titre part avec la charge utile : le panneau est une COPIE dans %APPDATA%, il ne
    // sait pas où NetsuRush range ses ressources.
    const byApi = () => adobeBridge.placeTimeline(ev, "ppro",
      adobePayload(doc, { ...opts, mogrt: titleTemplatePath() || undefined }));
    if (!canImportToPremiere(opts.from, opts)) return byApi();
    const resolve = await getResolve();
    if (!resolve) return byApi();

    emit(ev, "import", 0, 1);
    const exported = await exportResolveTimelineXml(resolve, opts.timelineName || null);
    if (exported.ok !== true) {
      console.warn("[transfer] export d'échange indisponible, pose par l'API :", exported.reason);
      return byApi();
    }
    // Retouche du fichier AVANT l'import : Resolve écrit les retours à la ligne d'un titre en
    // référence de caractère, que l'importeur de Premiere affiche telle quelle à l'image.
    try {
      const source = await fsp.readFile(exported.path, "utf8");
      const prepared = prepareForPremiere(source);
      if (prepared.newlines) {
        await fsp.writeFile(exported.path, prepared.text, "utf8");
        console.log(`[transfer] ${prepared.newlines} retour(s) à la ligne de titre décodé(s) pour Premiere`);
      }
    } catch (error) {
      console.warn("[transfer] fichier d'échange non retouché :", (error && error.message) || error);
    }
    let result;
    try {
      result = await adobeBridge.importTimeline(ev, "ppro", {
        path: exported.path,
        name: opts.name || doc.timeline || undefined,
      });
    } catch (error) {
      await removeQuietly(exported.path);
      throw error;
    }
    emit(ev, "import", 1, 1);
    if (result && result.ok) {
      await removeQuietly(exported.path);
      return { ...result, vehicle: "import" };
    }
    // Le fichier SURVIT au refus : l'import à la main (Fichier ▸ Importer) reste possible, et lui
    // seul apporte le titre.
    console.warn("[transfer] import refusé par Premiere, pose par l'API :", result && result.error);
    console.warn("[transfer] fichier d'échange conservé (Fichier ▸ Importer) :", exported.path);
    const fallback = await byApi();
    return { ...fallback, exchangeFile: exported.path, vehicle: "api" };
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
        animated: ae.animated, containerFallbacks: ae.containerFallbacks,
      };
      return { ...result, fidelity: transferReport(assessTransfer(source, to, targetCapabilities(to, opts)), result) };
    }

    emit(ev, "read", 0, 1);
    const read = await readDoc({ host: from, timelineName: opts.timelineName });
    if (!isDoc(read)) return read;
    if (!read.clips.length) return { ok: false, error: t("noTransferClips"), missing: read.missing };
    emit(ev, "read", 1, 1);

    // Liens directs, réencapsulage ou réencodage : le document repart avec les fichiers produits.
    const prepared = await prepareDoc({ run: runFfmpeg, runUpscale, runTurbo }, ev, read, opts);
    if (!isDoc(prepared)) return prepared;
    const doc = prepared;

    const assessment = assessTransfer(doc, to, targetCapabilities(to, opts));
    const result = to === "resolve"
      ? await writeResolve(ev, doc, opts)
      : (to === "ppro"
        ? await writePremiere(ev, doc, opts)
        : await adobeBridge.placeTimeline(ev, to, adobePayload(doc, opts)));

    emit(ev, "done", 1, 1);
    const fidelity = transferReport(assessment, result);
    logFidelityLosses(fidelity);
    return {
      ...result,
      from,
      to,
      source: doc.timeline,
      missing: result.missing || doc.missing,
      mediaLess: doc.mediaLess,
      fidelity,
    };
  }

  return { listSources, readDoc, summary, run };
}

module.exports = { createTransfer, canImportToPremiere, adobePayload, adobeSources, transferSummary, isSupportedPair, HOSTS, TRANSFER_TARGETS };
