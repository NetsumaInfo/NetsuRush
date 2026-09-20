// @ts-check
// Porte de permission de l'agent IA. TROIS modes, et une case à part :
//   'read-only' — lecture seule : écriture et destructif REFUSÉS, sans rien demander
//   'ask'       — confirme UNIQUEMENT le destructif (fichiers/rendu/suppression média) ; lecture et
//                 écriture timeline (montage, audio, markers…) passent sans demander (défaut)
//   'auto'      — tout autorisé sans confirmation
//
// Il y en avait un quatrième, 'safe', qui autorisait tout MAIS dupliquait la timeline avant la
// première écriture. C'était une case à cocher déguisée en mode : la duplication est orthogonale au
// niveau d'autorisation, et la coupler au mode le plus permissif rendait la doublure inaccessible à
// qui voulait aussi être consulté. C'est `duplicateFirst` maintenant, combinable avec n'importe
// quel mode et DÉCOCHÉ par défaut — dupliquer sans qu'on l'ait demandé laisse des timelines
// orphelines dans le projet.
//
// Quand une confirmation est requise : diffuse `chat:approval` en SSE {runId,callId,name,input,risk}
// → le renderer affiche allow/deny → `respond(callId, approved)` résout la promesse en attente.

/** @typedef {'read-only'|'ask'|'auto'} PermMode */

const MODES = ['read-only', 'ask', 'auto'];

/** @param {{broadcast:(ch:string,p:any)=>void}} deps */
function createPermissions({ broadcast }) {
  /** @type {PermMode} */
  let mode = 'ask';
  let duplicateFirst = false;
  let seq = 1;
  /** @type {Map<number,(approved:boolean)=>void>} */
  const pending = new Map();

  /** @param {PermMode} m */
  function setMode(m) {
    // L'ancien 'safe' est reçu comme « auto + doublure » : un réglage persisté
    // d'avant la scission ne doit pas retomber silencieusement sur le défaut.
    if (String(m) === 'safe') { mode = 'auto'; duplicateFirst = true; return; }
    if (MODES.includes(String(m))) mode = m;
  }
  function getMode() { return mode; }

  /** @param {boolean} on */
  function setDuplicateFirst(on) { duplicateFirst = !!on; }
  function getDuplicateFirst() { return duplicateFirst; }

  // Décision SYNCHRONE selon le mode et le risque, ou 'prompt' si une confirmation est nécessaire.
  /** @param {'read'|'write'|'destructive'} risk @returns {'allow'|'deny'|'prompt'} */
  function decide(risk) {
    if (mode === 'auto') return 'allow';
    if (mode === 'read-only') return risk === 'read' ? 'allow' : 'deny';
    // 'ask' : seul le DESTRUCTIF (touche fichiers/rendu/suppression média) demande confirmation ;
    // lecture + écriture timeline (montage, audio, markers, build…) passent directement.
    return risk === 'destructive' ? 'prompt' : 'allow';
  }

  // Vérifie une demande d'appel d'outil. Résout {approved, reason}.
  /** @param {string} runId @param {{name:string,input:any,risk:'read'|'write'|'destructive'}} call */
  function check(runId, call) {
    const verdict = decide(call.risk);
    if (verdict === 'allow') return Promise.resolve({ approved: true });
    if (verdict === 'deny') {
      return Promise.resolve({ approved: false, reason: `mode ${mode} : action ${call.risk} refusée` });
    }
    // prompt → attend la réponse du renderer
    const callId = seq++;
    return new Promise((resolve) => {
      pending.set(callId, (approved) =>
        resolve(approved ? { approved: true } : { approved: false, reason: 'refusé par l’utilisateur' }));
      broadcast('chat:approval', { runId, callId, name: call.name, input: call.input, risk: call.risk });
    });
  }

  // Réponse du renderer à une demande d'approbation.
  /** @param {number} callId @param {boolean} approved */
  function respond(callId, approved) {
    const fn = pending.get(callId);
    if (fn) { pending.delete(callId); fn(!!approved); }
    return { ok: true };
  }

  // Rejette toutes les demandes en attente (annulation de session / arrêt du core).
  function cancelAll() {
    for (const fn of pending.values()) fn(false);
    pending.clear();
  }

  return {
    setMode, getMode, setDuplicateFirst, getDuplicateFirst,
    decide, check, respond, cancelAll,
  };
}

module.exports = { createPermissions };
