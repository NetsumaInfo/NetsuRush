// @ts-check
// Lancement d'un agent CLI (claude/codex/…) : spawn → (prompt sur stdin) → stdout ligne-à-ligne →
// parser → événements normalisés (onEvent). Gère l'annulation (kill) et l'erreur de spawn.
// Les outils NetsuRush sont fournis au CLI via le serveur MCP (mcpConfigPath, cf. defs mcpInjection).

const { spawn } = require('child_process');
const { parserFor } = require('./parsers');

/**
 * @param {{
 *   def:import('./types').RuntimeAgentDef, prompt:string, model?:string,
 *   mcpConfigPath?:string, cwd?:string, env?:NodeJS.ProcessEnv,
 *   onEvent:(ev:any)=>void
 * }} opts
 * @returns {{ child:import('child_process').ChildProcess, done:Promise<void> }}
 */
function startCliRun(opts) {
  const { def, prompt, model, mcpConfigPath, cwd, env, onEvent } = opts;
  const args = def.buildArgs({ prompt, model, mcpConfigPath, cwd });
  const child = spawn(def.bin, args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...(env || {}) },
    windowsHide: true,
    shell: true, // résout claude.cmd / codex.cmd sur Windows
  });

  const { mode, fn } = parserFor(def.streamFormat);
  let buf = '';
  let errTail = '';
  let emittedDone = false;

  child.stdout.on('data', (d) => {
    const s = d.toString();
    if (mode === 'raw') { for (const e of fn(s)) emit(e); return; }
    buf += s;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      for (const e of fn(line)) emit(e);
    }
  });
  child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });

  function emit(e) {
    if (e.type === 'done') emittedDone = true;
    onEvent(e);
  }

  if (def.promptViaStdin) {
    try { child.stdin.write(prompt); child.stdin.end(); } catch { /* noop */ }
  }

  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      if (buf.trim() && mode === 'lines') { for (const e of fn(buf)) emit(e); }
      if (!emittedDone) {
        if (code && code !== 0) onEvent({ type: 'error', message: `agent ${def.id} sorti en ${code} : ${errTail || 'pas de détail'}` });
        onEvent({ type: 'done', stopReason: code ? 'error' : 'end' });
      }
      resolve();
    });
    child.on('error', (e) => {
      onEvent({ type: 'error', message: `lancement ${def.id} impossible : ${String((e && e.message) || e)}` });
      onEvent({ type: 'done', stopReason: 'error' });
      resolve();
    });
  });

  return { child, done };
}

module.exports = { startCliRun };
