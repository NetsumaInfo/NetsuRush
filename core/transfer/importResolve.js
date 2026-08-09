// @ts-check
// Voie PRINCIPALE de Premiere vers Resolve : faire importer par Resolve l'export FCP7 XML de la
// séquence, via `MediaPool.ImportTimelineFromFile`.
//
// Pourquoi celle-ci plutôt que la pose plan par plan : l'importeur de Resolve applique lui-même ce
// qu'aucune API de script ne sait écrire — position, échelle, rotation et opacité AVEC leurs images
// clés, les niveaux audio en dB et leur automation, la vitesse, les titres, les imbriquées. Poser
// les plans par `AppendToTimeline` puis tenter de recoller l'animation par-dessus refait à la main,
// moins bien, un travail que l'application fait nativement.
//
// La pose par l'API reste indispensable là où l'import ne va pas : ajouter à une timeline existante
// (l'import crée toujours une timeline neuve) et poser des médias que NetsuRush vient de produire.

const fs = require("fs");
const { uniqueTimelineName, sanitizeTimelineName, getTimelineByName } = require("../timeline");
const { importVariants } = require("./xmeml/normalize");
const { prepareForImport } = require("./xmeml/prepare");
const { openProject } = require("./writeResolveShared");
const { t } = require("../i18n");

/** Nom libre pour la timeline importée : Resolve refuse un doublon en silence. */
async function targetName(project, doc, opts) {
  const wanted = sanitizeTimelineName(opts.name || doc.timeline || "NetsuRush");
  return uniqueTimelineName(project, wanted);
}

/** Compte les plans réellement posés, seul chiffre qui prouve que l'import a produit quelque chose. */
async function countItems(timeline) {
  let total = 0;
  for (const kind of ["video", "audio"]) {
    const tracks = parseInt(await timeline.GetTrackCount(kind), 10) || 0;
    for (let track = 1; track <= tracks; track++) {
      let items = [];
      try { items = (await timeline.GetItemListInTrack(kind, track)) || []; } catch (_) { items = []; }
      total += items.length;
    }
  }
  return total;
}

/**
 * Dossiers de recherche des sources. Le XML porte les chemins d'origine ; quand un média a bougé,
 * `sourceClipsPath` évite un import de timeline aux plans hors ligne.
 */
function importOptions(name, doc) {
  const options = { timelineName: name, importSourceClips: true };
  const roots = new Set();
  for (const clip of doc.clips || []) {
    const path = String(clip.path || "");
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (cut > 0) roots.add(path.slice(0, cut));
  }
  // Une seule racine est acceptée par l'API ; au-delà, laisser Resolve suivre les chemins du XML.
  if (roots.size === 1) options.sourceClipsPath = Array.from(roots)[0];
  return options;
}

/**
 * Document dont les éléments sans média sont traduits : un titre en générateur de texte que Resolve
 * pose lui-même, le reste retiré.
 *
 * Un titre Premiere est un média SYNTHÉTIQUE dont le `<file>` ne porte aucun `<pathurl>`, et
 * `ImportTimelineFromFile` refuse alors le fichier ENTIER — mesuré, sans exception ni message,
 * là où Fichier ▸ Importer ▸ Timeline accepte le même document. Un seul titre condamnait donc tout
 * le transfert, plans et images clés compris.
 */
function prepareSource(filePath) {
  let source = "";
  try { source = fs.readFileSync(filePath, "utf8"); } catch (_) { return { text: "", graphics: [], titles: 0, dropped: 0, channels: 0 }; }
  return prepareForImport(source);
}

/**
 * Style que le titre AURAIT dû prendre. Resolve pose le texte, la piste, l'image de départ et la
 * durée, mais rien ne lui fait accepter la police ni le corps : `fontsize` est stocké puis ignoré,
 * le titre importé n'expose ni composition Fusion ni propriété de texte, un Text+ ne se décrit pas
 * en FCP7, et son style est absent du format natif `.drt`. Le dire vaut mieux que de laisser
 * chercher : deux valeurs à recopier dans l'inspecteur, contre un défaut à diagnostiquer.
 * @param {import('./types').TransferGraphic[]} graphics
 */
function reportTitleStyle(graphics) {
  const styled = graphics.filter((graphic) => graphic.font || graphic.size);
  if (!styled.length) return;
  console.log("[transfer] titres posés — style à reprendre à la main (Resolve n'accepte pas la police "
    + "ni le corps par import) : "
    + JSON.stringify(styled.map((graphic) => ({
      texte: graphic.text, police: graphic.font, corps: graphic.size, piste: `V${graphic.track}`,
    }))));
}

function siblingPath(filePath, label) {
  return filePath.replace(/\.xml$/i, "") + `.${label.replace(/[^a-z0-9]+/gi, "-")}.xml`;
}

/**
 * Fichiers à présenter à l'importeur : le document nettoyé d'abord, puis ses variantes d'en-tête.
 * Le fichier d'origine n'est réutilisé tel quel que s'il ne portait aucun titre — sinon il ferait
 * échouer le premier essai, celui qui doit réussir.
 */
function fileVariants(filePath, prepared) {
  const variants = [];
  for (const variant of importVariants(prepared.text)) {
    if (variant.label === "source" && !prepared.titles && !prepared.dropped && !prepared.channels) {
      variants.push({ label: "source", path: filePath });
      continue;
    }
    const target = siblingPath(filePath, variant.label === "source" ? "titres-traduits" : variant.label);
    try {
      fs.writeFileSync(target, variant.text, "utf8");
      variants.push({ label: variant.label, path: target });
    } catch (error) {
      console.warn("[transfer] variante d'import non écrite :", variant.label, (error && error.message) || error);
    }
  }
  return variants;
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch (_) { return 0; }
}

/** La page Montage donne accès au Media Pool ; l'échec n'est pas bloquant, seulement rapporté. */
async function openEditPage(resolve) {
  try {
    const page = await resolve.GetCurrentPage();
    if (page === "edit" || page === "cut" || page === "media") return;
    await resolve.OpenPage("edit");
  } catch (error) {
    console.warn("[transfer] page Montage non atteinte avant l'import :", (error && error.message) || error);
  }
}

/** Noms des timelines du projet, pour repérer celle qu'un import vient d'ajouter. */
async function timelineNames(project) {
  const names = new Set();
  const count = parseInt(await project.GetTimelineCount(), 10) || 0;
  for (let index = 1; index <= count; index++) {
    try {
      const timeline = await project.GetTimelineByIndex(index);
      if (timeline) names.add(String(await timeline.GetName()));
    } catch (_) { /* timeline illisible : elle ne peut pas être celle qu'on vient de créer */ }
  }
  return names;
}

/** Timeline apparue depuis le relevé `before`. Une seule nouvelle timeline = celle de l'import. */
async function newTimeline(project, before) {
  const count = parseInt(await project.GetTimelineCount(), 10) || 0;
  const fresh = [];
  for (let index = 1; index <= count; index++) {
    try {
      const timeline = await project.GetTimelineByIndex(index);
      if (timeline && !before.has(String(await timeline.GetName()))) fresh.push(timeline);
    } catch (_) { /* idem */ }
  }
  return fresh.length === 1 ? fresh[0] : null;
}

/**
 * Jeux d'options, du plus précis au plus nu. Une clé que la version installée ne connaît pas fait
 * échouer l'appel ENTIER sans dire laquelle : relâcher progressivement est la seule façon de
 * distinguer « Resolve refuse ce fichier » de « Resolve refuse cette option ».
 */
function importAttempts(name, doc) {
  const full = importOptions(name, doc);
  /** @type {Record<string, any>[]} */
  const attempts = [full];
  if (full.sourceClipsPath) {
    const { sourceClipsPath: _dropped, ...withoutPath } = full;
    attempts.push(withoutPath);
  }
  attempts.push({ timelineName: name });
  // `null` = appel à UN SEUL argument. Le second est optionnel dans l'API, et un dictionnaire vide
  // n'est pas la même chose qu'un argument absent quand il traverse le pont Python.
  attempts.push(null);
  return attempts;
}

/**
 * Importe dans Resolve un fichier d'échange déjà écrit sur disque.
 * @param {string} filePath XML/FCPXML/AAF produit par l'hôte source
 * @param {import('./types').TransferDoc} doc lecture du même montage, pour nommer et recouper
 * @param {{ name?: string }} [opts]
 */
async function importResolveTimeline(filePath, doc, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: t("transferFileMissing") };

  const opened = await openProject();
  if (opened.ok !== true) return { ok: false, error: opened.error };
  const { project, mediaPool } = opened;

  const prepared = prepareSource(filePath);
  if (!prepared.text) return { ok: false, error: t("transferFileMissing") };
  const name = await targetName(project, doc, opts);
  // Les timelines AVANT l'import : c'est le seul repérage fiable de celle qui vient d'être créée.
  // Resolve nomme parfois la timeline d'après le fichier plutôt que d'après `timelineName`, et la
  // chercher sous le nom DEMANDÉ concluait alors à l'échec d'un import parfaitement réussi.
  const before = await timelineNames(project);
  console.log(`[transfer] import — fichier ${fileSize(filePath)} o, nom demandé « ${name} », `
    + `${before.size} timeline(s) déjà présente(s) : ${JSON.stringify(Array.from(before))}`
    + (prepared.titles ? ` · ${prepared.titles} titre(s) traduit(s) en générateur` : "")
    + (prepared.dropped ? ` · ${prepared.dropped} élément(s) sans média écarté(s)` : "")
    + (prepared.channels ? ` · ${prepared.channels} canal/canaux audio éclaté(s) recollé(s)` : ""));
  // L'import de timeline agit sur le Media Pool : certaines versions le refusent depuis une page
  // qui n'y donne pas accès (Fusion, Fairlight, Livraison).
  await openEditPage(opened.resolve);

  const attempts = importAttempts(name, doc);
  const variants = fileVariants(filePath, prepared);
  let imported = null;
  let lastError = null;
  for (const variant of variants) {
    // Resolve lit les chemins en barres OBLIQUES ; un antislash traverse le pont Python comme une
    // séquence d'échappement, et le fichier « n'existe pas » côté Resolve sans autre explication.
    const importPath = variant.path.replace(/\\/g, "/");
    for (const options of attempts) {
      try {
        imported = options === null
          ? await mediaPool.ImportTimelineFromFile(importPath)
          : await mediaPool.ImportTimelineFromFile(importPath, options);
      } catch (error) {
        lastError = (error && error.message) || String(error);
        imported = null;
      }
      // Le RETOUR ne fait pas foi : selon la version, l'API rend `None` sur un import qui a
      // pourtant créé la timeline. Sans ce contrôle, on enchaînait les tentatives en croyant à
      // l'échec — et chacune ajoutait sa timeline au projet.
      const created = await newTimeline(project, before);
      console.log(`[transfer] ImportTimelineFromFile [${variant.label}]`,
        options === null ? "(sans options)" : JSON.stringify(options),
        "→", imported && typeof imported === "object" ? "timeline" : JSON.stringify(imported),
        created ? "· une timeline est APPARUE" : "");
      if (imported || created) { imported = imported || created; break; }
      // Un jeu d'options refusé ne dit pas lequel gêne : on relâche du plus spécifique au plus nu.
    }
    if (imported) break;
  }
  // Les retouches ne servaient qu'à l'essai : seul le document d'origine reste sur le disque.
  for (const variant of variants) {
    if (variant.path !== filePath) { try { fs.unlinkSync(variant.path); } catch (_) { /* déjà parti */ } }
  }

  const timeline = (imported && typeof imported === "object" ? imported : null)
    || (await newTimeline(project, before))
    || (await getTimelineByName(project, name));
  if (!timeline) {
    const detail = lastError ? `${name} (${lastError})` : name;
    return { ok: false, error: `${t("timelineImportFailed")}: ${detail}` };
  }

  const count = await countItems(timeline);
  let created = name;
  try { created = String(await timeline.GetName()) || name; } catch (_) { created = name; }
  if (count > 0 && prepared.titles) reportTitleStyle(prepared.graphics);
  return {
    ok: count > 0,
    vehicle: "import",
    timeline: created,
    count,
    created: true,
    // Les titres sont posés par l'importeur lui-même, comme les plans : ils sont dans le compte.
    titles: prepared.titles || undefined,
    // Texte, piste, image et durée sont exacts ; la police et le corps restent ceux de Resolve.
    titlesApproximated: prepared.titles || undefined,
    error: count > 0 ? undefined : `${t("timelineImportEmpty")}: ${created}`,
  };
}

module.exports = { importResolveTimeline, importOptions };
