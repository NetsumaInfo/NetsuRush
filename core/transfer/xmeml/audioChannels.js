// @ts-check
// Canaux audio ÉCLATÉS d'un export Premiere. Fonctions PURES.
//
// Avec `explodedTracks="true"` — ce que Premiere écrit par défaut — un fichier stéréo posé sur UNE
// piste sort du XML en DEUX `<clipitem>` mono, un par canal, sur deux `<track>` distincts, qui ne
// diffèrent que par leur `<sourcetrack><trackindex>`. Premiere en affiche un seul ; l'importeur de
// la cible les prend au mot et pose les deux. Mesuré : deux pistes audio de plus, portant deux fois
// le même son aux mêmes images — c'est le doublon visible dans Resolve.
//
// On ne garde donc que le PREMIER canal de chaque groupe et on laisse la cible refaire le stéréo à
// partir du fichier. Le regroupement exige que TOUT concorde (fichier, position, bornes source) :
// un même son délibérément posé deux fois par l'utilisateur porte les mêmes bornes SOURCE mais pas
// la même position, et deux clips au même endroit sur des pistes différentes gardent le même
// `trackindex` — dans les deux cas ils survivent.

const { parseXml, childNamed, childrenNamed, childText, childNumber } = require("./xmlText");

/** Premiere ne fait éclater les canaux que lorsqu'il le déclare. */
function tracksAreExploded(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.name === "sequence" && node.attrs && String(node.attrs.explodedTracks) === "true") return true;
    stack.push(...(node.children || []));
  }
  return false;
}

/** Canal source du clip. Absent = canal unique, donc rien à regrouper. */
function channelIndex(clipitem) {
  const sourcetrack = childNamed(clipitem, "sourcetrack");
  return sourcetrack ? childNumber(sourcetrack, "trackindex", 0) : 0;
}

/** Ce qui doit concorder pour que deux clips soient DEUX CANAUX du même son. */
function channelKey(clipitem) {
  const file = childNamed(clipitem, "file");
  const id = file && file.attrs ? file.attrs.id : "";
  if (!id) return "";
  return [id, childText(clipitem, "start"), childText(clipitem, "end"),
    childText(clipitem, "in"), childText(clipitem, "out")].join("|");
}

/**
 * Ids des clips audio qui ne sont qu'un canal supplémentaire.
 * @param {string} source contenu du fichier XML
 * @returns {Set<string>}
 */
function redundantChannelIds(source) {
  const dropped = new Set();
  const root = parseXml(String(source || ""));
  if (!root || !tracksAreExploded(root)) return dropped;

  /** @type {Map<string, { index: number, id: string }[]>} */
  const groups = new Map();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.name === "audio") {
      for (const track of childrenNamed(node, "track")) {
        for (const clipitem of childrenNamed(track, "clipitem")) {
          const key = channelKey(clipitem);
          const index = channelIndex(clipitem);
          const id = (clipitem.attrs && clipitem.attrs.id) || "";
          if (!key || !index || !id) continue;
          if (!groups.has(key)) groups.set(key, []);
          (groups.get(key) || []).push({ index, id });
        }
      }
    }
    stack.push(...(node.children || []));
  }

  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    // Deux clips au MÊME rang de canal ne sont pas un stéréo éclaté mais un son délibérément posé
    // deux fois : on n'y touche pas. Les rangs distincts, eux, sont les canaux d'un même clip.
    const ranks = new Set(entries.map((entry) => entry.index));
    if (ranks.size !== entries.length) continue;
    // Le canal de plus petit rang reste : c'est celui que la cible lira comme le clip.
    const lowest = entries.reduce((best, entry) => (entry.index < best.index ? entry : best));
    for (const entry of entries) {
      if (entry !== lowest) dropped.add(entry.id);
    }
  }
  return dropped;
}

/** Ids des `<clipitem>` d'un bloc de piste, dans l'ordre du document. */
function clipIdsOf(block) {
  const ids = [];
  const pattern = /<clipitem[^>]*\sid="([^"]*)"/g;
  let match = pattern.exec(block);
  while (match) { ids.push(match[1]); match = pattern.exec(block); }
  return ids;
}

/**
 * Retire les canaux surnuméraires ET les `<track>` qui ne portaient qu'eux. Sans ce second retrait,
 * chaque stéréo laisse derrière lui une piste VIDE chez la cible — Premiere en montrait deux, on en
 * livrerait quatre. Une piste vidéo ne peut pas être emportée : ses clips ne sont jamais dans
 * `dropped`, et une piste déjà vide (aucun clip du tout) n'est pas touchée.
 * @param {string} source
 * @param {Set<string>} dropped
 */
function stripChannels(source, dropped) {
  if (!dropped.size) return String(source);
  let out = "";
  let cursor = 0;
  const text = String(source);
  for (;;) {
    const start = text.indexOf("<track", cursor);
    if (start < 0) { out += text.slice(cursor); break; }
    const end = text.indexOf("</track>", start);
    if (end < 0) { out += text.slice(cursor); break; }
    const stop = end + "</track>".length;
    const block = text.slice(start, stop);
    const ids = clipIdsOf(block);
    out += text.slice(cursor, start);
    cursor = stop;
    if (ids.length && ids.every((id) => dropped.has(id))) continue;
    out += ids.some((id) => dropped.has(id)) ? replaceClipItems(block, dropped) : block;
  }
  return out;
}

/** @param {string} block @param {Set<string>} dropped */
function replaceClipItems(block, dropped) {
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = block.indexOf("<clipitem", cursor);
    if (start < 0) { out += block.slice(cursor); break; }
    const end = block.indexOf("</clipitem>", start);
    if (end < 0) { out += block.slice(cursor); break; }
    const stop = end + "</clipitem>".length;
    const piece = block.slice(start, stop);
    const id = /^<clipitem[^>]*\sid="([^"]*)"/.exec(piece);
    out += block.slice(cursor, start);
    if (!id || !dropped.has(id[1])) out += piece;
    cursor = stop;
  }
  return out;
}

/**
 * Recolle les canaux éclatés d'un document.
 * @param {string} source
 * @returns {{ text: string, channels: number }}
 */
function collapseAudioChannels(source) {
  const dropped = redundantChannelIds(source);
  return { text: stripChannels(source, dropped), channels: dropped.size };
}

module.exports = { collapseAudioChannels, redundantChannelIds, tracksAreExploded };
