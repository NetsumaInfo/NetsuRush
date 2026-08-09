// @ts-check
// Détection des agents CLI installés sur le PATH (sonde de version). Résultat consommé par l'UI
// (AgentPicker) et la session (choisir un agent disponible). Best-effort, jamais bloquant.

const { execFile } = require('child_process');
const { listDefs } = require('./defs');

/** @param {string} bin @param {string[]} args @param {number} timeoutMs */
function probe(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    // shell:true → résout claude.cmd / codex.cmd sur Windows (npm bins) sans extension explicite.
    const child = execFile(bin, args, { timeout: timeoutMs, windowsHide: true, shell: true }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(String(stdout || '').trim().split('\n')[0] || 'ok');
    });
    child.on('error', () => resolve(null));
  });
}

// Sonde un agent (binaire principal puis repli). Renvoie {id,name,available,version,bin}.
/** @param {import('./types').RuntimeAgentDef} def */
async function detectOne(def) {
  for (const bin of [def.bin, ...(def.fallbackBins || [])]) {
    const version = await probe(bin, def.versionArgs, 4000);
    if (version != null) {
      return { id: def.id, name: def.name, available: true, version, bin, models: def.models || [] };
    }
  }
  return { id: def.id, name: def.name, available: false, version: null, bin: def.bin, models: def.models || [] };
}

// Sonde tous les agents en parallèle.
async function detectAgents() {
  return Promise.all(listDefs().map(detectOne));
}

module.exports = { detectAgents, detectOne };
