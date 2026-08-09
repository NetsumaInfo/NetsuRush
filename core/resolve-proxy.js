// @ts-check
// core/resolve-proxy.js
// Expose l'API objet Resolve (resolve.GetProjectManager().GetCurrentProject()...) AU-DESSUS du pont
// Python externe (resolve-bridge), via un Proxy JS : tout accès à une méthode forwarde
// `bridge.invoke(handle, method, args)`. Les objets Resolve renvoyés ({__handle__}) deviennent des
// proxies enfants ; passés en argument, ils sont ré-encodés en {__handle__} pour le helper Python.
//
// But : réutiliser TELLE QUELLE la logique frame-accurate de timeline.js / resolve.js (qui `await`
// déjà chaque appel Resolve) — seule la couche objet sous-jacente change (WorkflowIntegration → bridge).

const { createResolveBridge } = require("./resolve-bridge");

const bridge = createResolveBridge();

function isHandle(v) {
  return v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "__handle__");
}

// Proxy enfant → {__handle__} ; tableaux/objets parcourus récursivement.
function encodeArg(a) {
  if (a && typeof a === "object") {
    if (typeof a.__nrHandle === "number") return { __handle__: a.__nrHandle };
    if (Array.isArray(a)) return a.map(encodeArg);
    const o = {};
    for (const k of Object.keys(a)) o[k] = encodeArg(a[k]);
    return o;
  }
  return a;
}

// {__handle__} → proxy ; tableaux/objets parcourus récursivement.
function decodeVal(v) {
  if (isHandle(v)) return makeProxy(v.__handle__);
  if (Array.isArray(v)) return v.map(decodeVal);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = decodeVal(v[k]);
    return o;
  }
  return v;
}

function makeProxy(handle) {
  return new Proxy(Object.create(null), {
    get(_t, prop) {
      if (prop === "__nrHandle") return handle;
      if (prop === "then") return undefined; // pas un thenable (await sur le proxy ne doit pas le "drainer")
      if (typeof prop !== "string") return undefined;
      return (...args) => bridge.invoke(handle, prop, args.map(encodeArg)).then(decodeVal);
    },
  });
}

const ROOT = makeProxy(null); // handle null → objet Resolve racine côté Python

/**
 * Attribut NON appelable d'un objet Resolve (constantes `EXPORT_*`…). Le Proxy rend une fonction
 * pour toute propriété : sans ce détour, une constante serait invoquée au lieu d'être lue.
 * @param {any} target proxy Resolve
 * @param {string} name
 */
async function readAttribute(target, name) {
  const handle = target && typeof target.__nrHandle === "number" ? target.__nrHandle : null;
  return decodeVal(await bridge.attr(handle, name));
}

// Nombre d'opérations Resolve de HAUT NIVEAU en cours (bracketées dans rpc.js). Sert à savoir si un
// reset() du registre de handles est sûr : on ne purge QUE si l'op courante est seule en vol.
let _opDepth = 0;
// Numéro de l'opération de haut niveau en cours, et celle pour laquelle le registre a DÉJÀ été
// purgé. Une opération appelle `getResolve()` plusieurs fois — directement, puis à travers les
// helpers de `timeline.js` — et purger à chaque fois invalidait les handles que l'opération tenait
// depuis son premier appel : « handle invalide ou Resolve non connecté » en plein milieu d'un
// transfert, d'autant plus probable que l'opération est longue.
let _opSeq = 0;
let _resetSeq = -1;
function beginResolveOp() { if (++_opDepth === 1) _opSeq++; }
function endResolveOp() { if (_opDepth > 0) _opDepth--; }
// Profondeur d'ops en vol : lue par le build de cache (basse priorité) pour CÉDER aux lectures live.
function getOpDepth() { return _opDepth; }

// Connecte (idempotent) puis vide le registre de handles — MAIS seulement si cette opération est la
// SEULE en vol. Sinon le reset effacerait les handles qu'une opération concurrente tient en plein
// parcours → « handle invalide » (cas réel : Timeline Live = timelineThumbs en fond + listTimelines +
// readTimelineCuts + refreshStatus qui se chevauchent). Quand ≥2 ops tournent, on partage le registre
// (il croît, purgé au prochain appel solitaire). Null si Resolve injoignable.
async function getResolve() {
  try {
    const r = await bridge.connect();
    if (!r || !r.connected) return null;
    // Hors bracket, chaque appel repart d'un registre propre. Dans un bracket, on ne purge qu'au
    // PREMIER `getResolve()` de l'opération : les suivants s'appuient sur des handles déjà pris.
    if (_opDepth === 0) await bridge.reset();
    else if (_opDepth === 1 && _resetSeq !== _opSeq) {
      await bridge.reset();
      _resetSeq = _opSeq;
    }
    return ROOT;
  } catch {
    return null;
  }
}

module.exports = { bridge, getResolve, makeProxy, readAttribute, beginResolveOp, endResolveOp, getOpDepth };