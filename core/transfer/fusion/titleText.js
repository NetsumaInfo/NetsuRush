// @ts-check
// Réécriture du texte et du style d'un Text+ dans une composition Fusion exportée par Resolve.
// Fonctions PURES : aucun accès disque ni à Resolve, donc vérifiables sans hôte.
//
// Pourquoi passer par la comp plutôt que par une API de titre : `InsertFusionTitleIntoTimeline`
// pose un Text+ avec son contenu par DÉFAUT et l'API de script n'expose aucune écriture de texte.
// La composition est la seule surface où le contenu du titre est adressable.

/** Entrées du Text+ que NetsuRush pilote. Le reste du nœud est laissé tel que Resolve l'a écrit. */
const TEXT_INPUTS = ["StyledText", "Font", "Style", "Size", "Red1", "Green1", "Blue1", "Center"];

/**
 * Suffixes de nom PostScript : « Arial-BoldMT » nomme la famille Arial en style Bold. L'ordre
 * compte — « BoldItalic » contient « Bold », donc le style composé se teste en premier.
 */
const STYLE_SUFFIXES = [
  { pattern: /bold\s*(italic|oblique)/i, style: "Bold Italic" },
  { pattern: /(semi|demi)\s*bold/i, style: "Semibold" },
  { pattern: /bold/i, style: "Bold" },
  { pattern: /italic|oblique/i, style: "Italic" },
  { pattern: /light/i, style: "Light" },
  { pattern: /medium/i, style: "Medium" },
];

/** Marques de fonderie collées au nom : elles ne font partie ni de la famille ni du style. */
const FOUNDRY_MARKS = /(MT|PS|Std|Pro|OT|TT)$/i;

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value) {
  const rounded = Math.round(num(value, 0) * 1e6) / 1e6;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Échappement d'une chaîne pour un littéral Lua : la comp Fusion est du Lua, pas du JSON. */
function luaString(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n")}"`;
}

/**
 * Nom PostScript d'une police → famille + style, les deux entrées distinctes de Fusion.
 * Approximation assumée : rien ne relie un nom PostScript à un nom de famille système, et une
 * police introuvable retombe sur celle du modèle plutôt que d'échouer.
 */
function splitFontName(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const head = raw.split("-");
  // La marque de fonderie tombe AVANT la recherche de style : « BoldMT » n'est reconnu comme gras
  // qu'une fois « MT » retiré, et c'est la forme que Premiere donne le plus souvent.
  const suffix = head.length > 1 ? head.slice(1).join("-").replace(FOUNDRY_MARKS, "") : "";
  const found = STYLE_SUFFIXES.find((entry) => entry.pattern.test(suffix || raw));
  const family = head[0].replace(FOUNDRY_MARKS, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return { family: family || raw, style: found ? found.style : "Regular" };
}

/** Bloc `Nom = TextPlus { … }` du squelette, délimité par accolades équilibrées. */
function findTextTool(text) {
  const pattern = /(\w+)\s*=\s*(TextPlus)\s*\{/g;
  const match = pattern.exec(String(text || ""));
  if (!match) return null;
  const source = String(text);
  const open = source.indexOf("{", match.index);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return { name: match[1], start: match.index, end: index + 1, body: source.slice(open, index + 1) };
    }
  }
  return null;
}

/**
 * Valeurs Fusion d'un titre du document.
 * - `Size` est NORMALISÉ chez Fusion (fraction de la hauteur d'image) alors que l'hôte source
 *   compte en pixels : le rapport est la seule traduction possible, et elle est approchée.
 * - `Center` est en 0..1 avec l'origine en BAS à gauche ; le document compte en pixels depuis le
 *   centre avec Y vers le BAS.
 */
function titleInputs(graphic, timeline) {
  const height = Math.max(1, num(timeline && timeline.height, 1080));
  const width = Math.max(1, num(timeline && timeline.width, 1920));
  /** @type {Record<string, string>} */
  const inputs = { StyledText: luaString(graphic.text) };

  const font = splitFontName(graphic.font);
  if (font) {
    inputs.Font = luaString(font.family);
    inputs.Style = luaString(font.style);
  }
  if (num(graphic.size, 0) > 0) inputs.Size = formatNumber(num(graphic.size, 0) / height);
  if (graphic.color) {
    inputs.Red1 = formatNumber(num(graphic.color.r, 1));
    inputs.Green1 = formatNumber(num(graphic.color.g, 1));
    inputs.Blue1 = formatNumber(num(graphic.color.b, 1));
  }
  const position = graphic.transform && graphic.transform.position && graphic.transform.position.value;
  if (position) {
    inputs.Center = `{ ${formatNumber(0.5 + num(position.x, 0) / width)}, ${formatNumber(0.5 - num(position.y, 0) / height)} }`;
  }
  return inputs;
}

/** Remplace la valeur d'une entrée déjà présente, sinon rend `null` pour que l'appelant l'ajoute. */
function replaceInput(body, name, value) {
  const pattern = new RegExp(`(${name}\\s*=\\s*Input\\s*\\{\\s*Value\\s*=\\s*)([^,}]+|\\{[^}]*\\})(\\s*,?\\s*\\})`);
  return pattern.test(body) ? body.replace(pattern, `$1${value}$3`) : null;
}

/** Entrées absentes du modèle : insérées en tête du bloc `Inputs`, où Fusion les lit comme les autres. */
function insertInputs(body, pending) {
  const anchor = body.indexOf("Inputs = {");
  if (anchor < 0 || !pending.length) return body;
  const cut = body.indexOf("{", anchor + "Inputs =".length) + 1;
  const lines = pending.map(([name, value]) => `\n\t\t\t${name} = Input { Value = ${value}, },`).join("");
  return body.slice(0, cut) + lines + body.slice(cut);
}

/**
 * Composition d'un titre Fusion → même composition portant le texte et le style demandés.
 * @param {string} skeletonText comp exportée par Resolve pour le titre qu'il vient d'insérer
 * @param {import('../types').TransferGraphic} graphic
 * @param {{ width:number, height:number }} timeline
 * @returns {{ ok:true, text:string, applied:string[] } | { ok:false, reason:string }}
 */
function buildTitleComp(skeletonText, graphic, timeline) {
  if (!graphic || !String(graphic.text || "").trim()) return { ok: false, reason: "titleTextMissing" };
  const tool = findTextTool(skeletonText);
  if (!tool) return { ok: false, reason: "fusionTextToolMissing" };

  const inputs = titleInputs(graphic, timeline);
  const applied = [];
  const pending = [];
  let body = tool.body;
  for (const name of TEXT_INPUTS) {
    if (inputs[name] === undefined) continue;
    const replaced = replaceInput(body, name, inputs[name]);
    if (replaced) { body = replaced; applied.push(name); continue; }
    pending.push([name, inputs[name]]);
  }
  body = insertInputs(body, pending);
  pending.forEach(([name]) => applied.push(name));
  if (!applied.length) return { ok: false, reason: "fusionTextInputsMissing" };

  const source = String(skeletonText);
  const head = source.slice(0, tool.start);
  const rewritten = `${tool.name} = TextPlus ${body}`;
  return { ok: true, text: head + rewritten + source.slice(tool.end), applied };
}

/** Contrôle de relecture : le texte demandé est-il bien dans la comp enregistrée ? */
function compHasText(text, expected) {
  const tool = findTextTool(text);
  if (!tool) return false;
  const match = /StyledText\s*=\s*Input\s*\{\s*Value\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(tool.body);
  if (!match) return false;
  return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") === String(expected);
}

module.exports = { buildTitleComp, compHasText, splitFontName, findTextTool, TEXT_INPUTS };
