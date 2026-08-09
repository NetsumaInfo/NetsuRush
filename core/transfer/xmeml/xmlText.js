// @ts-check
// Sérialisation et lecture d'un XML PLAT (xmeml v5). Aucune dépendance : le core est CommonJS sans
// paquet XML, et xmeml n'emploie ni espace de noms ni entité exotique — un analyseur court reste
// vérifiable, là où un parseur générique ajouterait une dépendance au bundle pour rien.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Un jeton par alternative : commentaire, CDATA, prologue, DOCTYPE, fermeture, ouverture, texte.
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function escapeXml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function unescapeXml(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body) => {
    if (body[0] !== "#") {
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
    }
    const hex = body[1] === "x" || body[1] === "X";
    const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    return Number.isFinite(code) ? String.fromCharCode(code) : whole;
  });
}

function attributesText(attrs) {
  if (!attrs) return "";
  return Object.keys(attrs)
    .filter((key) => attrs[key] !== undefined && attrs[key] !== null)
    .map((key) => ` ${key}="${escapeXml(attrs[key])}"`)
    .join("");
}

/**
 * Élément XML. `children` accepte une chaîne (feuille texte, échappée), un tableau (fragments déjà
 * sérialisés, valeurs vides ignorées) ou `null` (balise auto-fermante).
 */
function tag(name, children, attrs) {
  const head = `<${name}${attributesText(attrs)}`;
  if (children === null || children === undefined) return `${head}/>`;
  const body = Array.isArray(children) ? children.filter(Boolean).join("") : escapeXml(children);
  return `${head}>${body}</${name}>`;
}

/** Feuille texte omise quand la valeur est absente : xmeml préfère l'absence à une balise vide. */
function optionalTag(name, value) {
  return value === undefined || value === null || value === "" ? "" : tag(name, value);
}

function parseAttributes(source) {
  const attrs = {};
  if (!source) return attrs;
  ATTRIBUTE.lastIndex = 0;
  let match = ATTRIBUTE.exec(source);
  while (match) {
    attrs[match[1]] = unescapeXml(match[2] !== undefined ? match[2] : match[3] || "");
    match = ATTRIBUTE.exec(source);
  }
  return attrs;
}

function makeNode(name, attrs) {
  return { name, attrs: attrs || {}, children: [], text: "" };
}

/**
 * XML → arbre `{ name, attrs, children, text }`. Renvoie null si le document n'a pas de racine :
 * un fichier tronqué doit se voir comme une lecture ratée, pas comme une timeline vide.
 */
function parseXml(source) {
  const root = makeNode("#document");
  const stack = [root];
  TOKEN.lastIndex = 0;
  let match = TOKEN.exec(String(source || ""));
  while (match) {
    const [whole, cdata, closing, opening, attrs, selfClosing, text] = match;
    const top = stack[stack.length - 1];
    if (cdata !== undefined) top.text += cdata;
    else if (text !== undefined) top.text += unescapeXml(text);
    else if (closing !== undefined) {
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].name !== closing) continue;
        stack.length = depth;
        break;
      }
    } else if (opening !== undefined) {
      const node = makeNode(opening, parseAttributes(attrs));
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    } else if (whole.slice(0, 4) !== "<!--" && whole.slice(0, 2) !== "<?" && whole[1] !== "!") {
      // Aucune autre alternative ne produit de nœud : le jeton est ignoré volontairement.
    }
    match = TOKEN.exec(String(source || ""));
  }
  return root.children[0] || null;
}

function childrenNamed(node, name) {
  return node && node.children ? node.children.filter((child) => child.name === name) : [];
}

function childNamed(node, name) {
  return childrenNamed(node, name)[0] || null;
}

/** Texte d'un enfant direct, débarrassé des blancs de mise en forme. */
function childText(node, name) {
  const child = childNamed(node, name);
  return child ? child.text.trim() : "";
}

function childNumber(node, name, fallback) {
  const value = Number(childText(node, name));
  return Number.isFinite(value) ? value : fallback;
}

/** xmeml écrit ses booléens en TRUE/FALSE ; `true`/`1` viennent d'autres émetteurs. */
function childBoolean(node, name, fallback) {
  const raw = childText(node, name).toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

module.exports = {
  escapeXml, unescapeXml, tag, optionalTag,
  parseXml, childNamed, childrenNamed, childText, childNumber, childBoolean,
};
