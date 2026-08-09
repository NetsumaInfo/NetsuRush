// @ts-check
// Titres d'un export FCP7 XML : les TRADUIRE dans le dialecte que l'importeur de la cible comprend.
// Fonctions PURES.
//
// Un titre Premiere est un média SYNTHÉTIQUE (`<mediaSource>GraphicAndType`) dont le `<file>` ne
// porte AUCUN `<pathurl>`. Mesuré sur Resolve Studio 21.0.3 : `ImportTimelineFromFile` refuse alors
// le fichier ENTIER, sans exception ni message, pendant que Fichier ▸ Importer ▸ Timeline accepte le
// même document — l'import manuel peut ouvrir une boîte pour un média absent, l'appel de script ne
// le peut pas. Un seul titre condamnait donc tout le transfert, plans et images clés compris.
//
// Il est REMPLACÉ, pas seulement retiré, par un `<generatoritem>` de texte FCP7. Resolve le pose
// alors lui-même à la bonne image, sur la bonne piste, pour la bonne durée, et le RÉ-EXPORTE mot
// pour mot (vérifié par aller-retour : `str`, `fontname` et `fontsize` reviennent intacts). C'est la
// seule voie exacte : `InsertFusionTitleIntoTimeline`, la seule écriture de titre de l'API, insère
// en RIPPLE sur la piste courante — mesuré, elle coupait le plan sous la tête de lecture et décalait
// tout le montage, vidéo ET audio, de la durée du titre.
//
// Le texte se lit ICI plutôt que par l'API de l'hôte parce que sur un titre NATIF de Premiere,
// `getValue()` du paramètre « Texte source » rend une valeur opaque (mesuré : un unique `ļ`). Le
// même paramètre voyage dans le XML en base64, et le texte comme la police y sont des chaînes
// longueur-préfixées parfaitement lisibles.

const { parseXml, childNamed, childrenNamed, childText, childNumber, unescapeXml, escapeXml } = require("./xmlText");

/** Effets Premiere qui portent un titre. */
const GRAPHIC_EFFECT_IDS = new Set(["graphicandtype"]);
/** Noms du paramètre porteur du texte, selon la langue de l'interface qui a exporté. */
const SOURCE_TEXT_PARAMS = new Set(["texte source", "source text"]);
/** Une chaîne du blob plus longue que ça n'est pas un nom de police ni un titre court. */
const MAX_FLAT_STRING = 4096;
/** Corps que Premiere n'écrit PAS, parce qu'il est la valeur par défaut du champ. */
const DEFAULT_FONT_SIZE = 100;
/** Bornes d'un corps plausible. En dessous, c'est un autre réglage du blob (mesuré : un 4.0 fixe). */
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 2000;

/** Nom de police plausible : une ligne, sans ponctuation exotique. */
function looksLikeFontName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9 .\-_]{1,63}$/.test(value);
}

/**
 * Chaînes lisibles d'un blob FlatBuffer Premiere. Le format n'est pas documenté ; ce qui l'est,
 * c'est sa façon d'écrire une chaîne — longueur sur 4 octets en petit-boutiste, octets UTF-8, puis
 * un zéro terminal. On ne décode donc pas la structure, on relève ce motif.
 * @param {string} base64
 * @returns {string[]}
 */
function flatStrings(base64) {
  let bytes;
  try { bytes = Buffer.from(String(base64 || ""), "base64"); } catch (_) { return []; }
  const found = [];
  for (let at = 0; at + 4 < bytes.length; at++) {
    const length = bytes.readUInt32LE(at);
    if (length < 2 || length > MAX_FLAT_STRING) continue;
    const stop = at + 4 + length;
    if (stop >= bytes.length || bytes[stop] !== 0) continue;
    const slice = bytes.subarray(at + 4, stop);
    // Un octet de commande (hors tabulation, retour chariot, saut de ligne) trahit une coïncidence
    // numérique plutôt qu'une vraie chaîne.
    if (slice.some((byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) continue;
    const text = slice.toString("utf8");
    if (text.includes("�")) continue;
    found.push(text);
    at = stop;
  }
  return found;
}

/**
 * Corps de la police, en points de la source. Mesuré sur deux exports du MÊME titre : à 100 le blob
 * fait 328 octets et ne contient qu'un flottant (4.0, un autre réglage) ; à 200 il en fait 332 et
 * porte en plus `00 00 48 43`, soit 200.0. C'est la sémantique FlatBuffers — un champ égal à sa
 * valeur par défaut n'est pas écrit — d'où le repli sur 100 quand rien n'est trouvé.
 *
 * On retient le PLUS GRAND flottant plausible plutôt qu'une position fixe : les décalages du blob
 * dépendent de la longueur du texte et du nom de police, alors que les autres réglages mesurés y
 * sont d'un ordre de grandeur inférieur. Un corps lu de travers se voit immédiatement, et le
 * journal le porte.
 * @param {string} base64
 */
function fontSizeFrom(base64) {
  let bytes;
  try { bytes = Buffer.from(String(base64 || ""), "base64"); } catch (_) { return DEFAULT_FONT_SIZE; }
  let largest = 0;
  // Pas de 4 : un flottant FlatBuffers est toujours aligné, et balayer octet par octet inventerait
  // des valeurs à cheval sur deux champs.
  for (let at = 0; at + 4 <= bytes.length; at += 4) {
    const value = bytes.readFloatLE(at);
    if (!Number.isFinite(value) || value < MIN_FONT_SIZE || value > MAX_FONT_SIZE) continue;
    if (value > largest) largest = value;
  }
  return largest ? Math.round(largest * 100) / 100 : DEFAULT_FONT_SIZE;
}

/**
 * Texte et police d'un titre, à partir du blob et du nom de l'effet. Premiere nomme le graphique
 * d'après son contenu tant que l'utilisateur ne l'a pas renommé : ce nom sert à DÉSIGNER laquelle
 * des chaînes du blob est le texte, ce qu'aucune heuristique de forme ne saurait faire seule.
 * @returns {{ text: string, font?: string, size: number }}
 */
function titleContent(blob, effectName) {
  const strings = flatStrings(blob);
  const name = String(effectName || "").replace(/\r\n?/g, "\n");
  const normalized = strings.map((value) => value.replace(/\r\n?/g, "\n"));
  let index = normalized.indexOf(name);
  // Graphique renommé : le nom ne désigne plus rien, on retient la chaîne qui n'est pas une police.
  if (index < 0) index = normalized.reduce((best, value, at) => (looksLikeFontName(value) ? best : at), -1);
  // Le texte vient du BLOB, jamais du nom de l'effet. Un graphique porte aussi des calques qui n'en
  // sont pas — mesuré : « Vector Motion », dont le nom se retrouvait collé dans le titre alors que
  // son blob ne contient aucune chaîne. Un titre perdu se voit ; un mot inventé au milieu du texte,
  // non.
  const text = index >= 0 ? normalized[index] : "";
  const font = strings.find((value, at) => at !== index && looksLikeFontName(value));
  return { text, font, size: fontSizeFrom(blob) };
}

/** Ids de `<file>` qui portent un chemin : un `<file id="…"/>` nu y renvoie et reste un vrai média. */
function pathBearingFileIds(root) {
  const ids = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.name === "file" && node.attrs && node.attrs.id && childText(node, "pathurl")) ids.add(node.attrs.id);
    stack.push(...(node.children || []));
  }
  return ids;
}

/** Le clip désigne-t-il un média absent du disque comme du document ? */
function isMediaLess(clipitem, pathIds) {
  const file = childNamed(clipitem, "file");
  if (!file) return true;
  if (childText(file, "pathurl")) return false;
  const id = file.attrs && file.attrs.id;
  return !(id && pathIds.has(id));
}

/**
 * TOUS les `<filter>` graphiques du clip, dans l'ordre du document. Un graphique Premiere porte un
 * calque par élément — texte, forme, image — et chacun sort en effet distinct. Ne retenir que le
 * PREMIER lisait le calque de forme, sans texte, et le titre disparaissait : mesuré dès que
 * l'utilisateur a ajouté un second calque.
 */
function graphicEffects(clipitem) {
  const effects = [];
  for (const filter of childrenNamed(clipitem, "filter")) {
    const effect = childNamed(filter, "effect");
    if (!effect) continue;
    const id = childText(effect, "effectid").toLowerCase();
    if (GRAPHIC_EFFECT_IDS.has(id) || childText(effect, "effectcategory").toLowerCase() === "graphic") {
      effects.push(effect);
    }
  }
  return effects;
}

/** Noms du paramètre d'échelle, selon la langue de l'interface qui a exporté. */
const SCALE_PARAMS = new Set(["echelle", "scale", "échelle"]);
/** Une échelle hors de ces bornes est une lecture ratée, pas un réglage. */
const MIN_SCALE = 1;
const MAX_SCALE = 10000;

/**
 * Échelle du calque, en pourcentage. Elle est en CLAIR dans le XML, à côté du blob, et elle
 * multiplie ce que le corps de la police produit à l'écran : agrandir un titre en tirant sur sa
 * boîte change l'échelle, pas le corps. Mesuré — un titre à 200 points mis à 298 % s'affiche comme
 * du 596, et n'écrire que 200 le rendait trois fois trop petit chez la cible.
 *
 * La valeur est le second champ d'une liste dont le premier est un horodatage d'image clé ; une
 * propriété animée en porte plusieurs, on retient la première.
 */
function layerScale(effect) {
  for (const parameter of childrenNamed(effect, "parameter")) {
    if (!SCALE_PARAMS.has(childText(parameter, "name").toLowerCase())) continue;
    const value = parseFloat(String(childText(parameter, "value")).split(",")[1]);
    if (!Number.isFinite(value) || value < MIN_SCALE || value > MAX_SCALE) return 100;
    return value;
  }
  return 100;
}

function sourceTextBlob(effect) {
  for (const parameter of childrenNamed(effect, "parameter")) {
    if (SOURCE_TEXT_PARAMS.has(childText(parameter, "name").toLowerCase())) return childText(parameter, "value");
  }
  return "";
}

/**
 * @param {any} clipitem
 * @param {number} track index 1-based de la piste vidéo
 * @returns {import('../types').TransferGraphic | null}
 */
function graphicFrom(clipitem, track) {
  const tlStart = childNumber(clipitem, "start", -1);
  const tlEnd = childNumber(clipitem, "end", -1);
  if (tlStart < 0 || tlEnd <= tlStart) return null;

  const layers = graphicEffects(clipitem)
    .map((effect) => {
      const content = titleContent(sourceTextBlob(effect), unescapeXml(childText(effect, "name")));
      // Ce qu'on voit à l'écran, c'est le corps MULTIPLIÉ par l'échelle du calque : la cible n'a
      // qu'un réglage de taille, les deux doivent donc y être fondus.
      return { ...content, size: Math.round(content.size * layerScale(effect) / 100) };
    })
    .filter((layer) => layer.text.trim());
  if (!layers.length) return null;
  // Plusieurs calques de texte occupent la MÊME place sur la timeline : la cible n'y pose qu'un
  // titre. On les empile en lignes plutôt que d'en perdre — leur position à l'écran est approchée,
  // leur contenu ne l'est pas.
  const text = layers.map((layer) => layer.text).join("\n");
  const font = layers.find((layer) => layer.font);
  return {
    track,
    name: childText(clipitem, "name") || layers[0].text,
    tlStart,
    tlEnd,
    text,
    font: font ? font.font : undefined,
    // Le corps du PREMIER calque de texte : la cible ne pose qu'un titre, elle ne sait pas en
    // varier la taille d'une ligne à l'autre.
    size: layers[0].size,
  };
}

function parameterTag(id, name, value) {
  return `<parameter><parameterid>${id}</parameterid><name>${name}</name><value>${escapeXml(value)}</value></parameter>`;
}

/**
 * Titre du document → générateur de texte FCP7. Le saut de ligne s'écrit en retour chariot :
 * c'est ce que Premiere émet et ce que Resolve ré-exporte.
 * @param {import('../types').TransferGraphic} graphic
 * @param {string} id
 */
function textGenerator(graphic, id) {
  const span = Math.max(1, graphic.tlEnd - graphic.tlStart);
  const parameters = [
    parameterTag("str", "Text", graphic.text).replace(/&#10;|\n/g, "&#13;"),
    graphic.font ? parameterTag("fontname", "Font", graphic.font) : "",
    graphic.size ? parameterTag("fontsize", "Size", String(Math.round(graphic.size))) : "",
  ].join("");
  return `<generatoritem id="${escapeXml(id)}"><name>Text</name><duration>${span}</duration>`
    + "<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>"
    + `<start>${graphic.tlStart}</start><end>${graphic.tlEnd}</end><in>0</in><out>${span}</out>`
    + "<enabled>TRUE</enabled>"
    + "<effect><name>Text</name><effectid>Text</effectid><effectcategory>Text</effectcategory>"
    + `<effecttype>generator</effecttype><mediatype>video</mediatype>${parameters}</effect></generatoritem>`;
}

/**
 * Réécrit les blocs `<clipitem>` désignés par leur id : remplacés par la valeur associée, ou retirés
 * quand elle est vide. Découpe TEXTUELLE, et remplacement SUR PLACE — ré-écrire le document depuis
 * l'arbre analysé perdrait tout ce que l'analyseur ne modélise pas, et déplacer le bloc changerait
 * la piste qui le porte.
 * @param {string} source
 * @param {Map<string, string>} replacements
 */
function replaceClipItems(source, replacements) {
  if (!replacements.size) return String(source);
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = String(source).indexOf("<clipitem", cursor);
    if (start < 0) { out += source.slice(cursor); break; }
    const end = String(source).indexOf("</clipitem>", start);
    if (end < 0) { out += source.slice(cursor); break; }
    const stop = end + "</clipitem>".length;
    const block = source.slice(start, stop);
    const id = /^<clipitem[^>]*\sid="([^"]*)"/.exec(block);
    out += source.slice(cursor, start);
    if (!id || !replacements.has(id[1])) out += block;
    else out += replacements.get(id[1]);
    cursor = stop;
  }
  return out;
}

/**
 * Traduit les éléments sans média d'un document FCP7 : un titre devient un générateur de texte, tout
 * le reste (cache de couleur, calque d'effet — rien qu'un échange puisse porter) est retiré. Dans
 * les deux cas ils quittent le document tel que l'hôte source l'a écrit, sans quoi l'importeur de la
 * cible refuserait le fichier entier.
 * @param {string} source contenu du fichier XML
 * @returns {{ text: string, graphics: import('../types').TransferGraphic[], titles: number, dropped: number }}
 */
function extractGraphics(source) {
  const text = String(source || "");
  const root = parseXml(text);
  if (!root) return { text, graphics: [], titles: 0, dropped: 0 };
  const pathIds = pathBearingFileIds(root);

  /** @type {import('../types').TransferGraphic[]} */
  const graphics = [];
  /** @type {Map<string, string>} */
  const replacements = new Map();
  let dropped = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    // Seules les pistes VIDÉO portent des titres ; on numérote dans l'ordre du document, comme les
    // plans, sans quoi le titre reviendrait sur une autre piste que celle qui le portait.
    if (node.name === "video") {
      childrenNamed(node, "track").forEach((track, index) => {
        for (const clipitem of childrenNamed(track, "clipitem")) {
          if (!isMediaLess(clipitem, pathIds)) continue;
          const id = (clipitem.attrs && clipitem.attrs.id) || "";
          const graphic = graphicFrom(clipitem, index + 1);
          if (graphic) graphics.push(graphic);
          if (!id) continue;
          if (graphic) replacements.set(id, textGenerator(graphic, `nr-title-${id}`));
          else { replacements.set(id, ""); dropped += 1; }
        }
      });
    }
    stack.push(...(node.children || []));
  }
  graphics.sort((a, b) => a.tlStart - b.tlStart || a.track - b.track);
  return { text: replaceClipItems(text, replacements), graphics, titles: graphics.length, dropped };
}

module.exports = {
  extractGraphics, flatStrings, titleContent, textGenerator, replaceClipItems,
};
