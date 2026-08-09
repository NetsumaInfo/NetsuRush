// @ts-check
// Porte de permission de l'agent IA. L'utilisateur choisit le MODE (cf. CLAUDE/réglages) :
//   'read-only' — autorise la lecture, REFUSE écriture + destructif (sans confirmation)
//   'ask'       — confirme UNIQUEMENT le destructif (fichiers/rendu/suppression média) ; lecture et
//                 écriture timeline (montage, audio, markers…) passent sans demander (recommandé, défaut)
//   'auto'      — tout autorisé sans confirmation, écrit DIRECT dans la timeline (rapide, risqué)
//   'safe'      — comme 'auto' mais DUPLIQUE la timeline courante avant la 1re écriture du tour,
//                 puis travaille sur la copie (la timeline d'origine n'est jamais touchée). La
//                 duplication est faite par la session (accès Resolve), pas ici.
//
// Quand une confirmation est requise : diffuse `chat:approval` en SSE {runId,callId,name,input,risk}
// → le renderer affiche allow/deny → `respond(callId, approved)` résout la promesse en attente.

/** @typedef {'read-only'|'ask'|'auto'|'safe'} PermMode */

/** @param {{broadcast:(ch:string,p:any)=>void}} deps */
function createPermissions({ broadcast }) {
  /** @type {PermMode} */
  let mode = 'ask';
  let seq = 1;
  /** @type {Map<number,(approved:boolean)=>void>} */
  const pending = new Map();

  /** @param {PermMode} m */
  function setMode(m) {
    if (m === 'auto' || m === 'safe' || m === 'ask' || m === 'read-only') mode = m;
  }
  function getMode() { return mode; }

  // Décision SYNCHRONE selon le mode et le risque, ou 'prompt' si une confirmation est nécessaire.
  /** @param {'read'|'write'|'destructive'} risk @returns {'allow'|'deny'|'prompt'} */
  function decide(risk) {
    if (mode === 'auto' || mode === 'safe') return 'allow';
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

  return { setMode, getMode, decide, check, respond, cancelAll };
}

module.exports = { createPermissions };
