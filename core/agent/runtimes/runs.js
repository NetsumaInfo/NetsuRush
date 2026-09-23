// @ts-check
// Lancement d'un agent CLI (claude/codex/…) : spawn → (prompt sur stdin) → stdout ligne-à-ligne →
// parser → événements normalisés (onEvent). Gère l'annulation (kill) et l'erreur de spawn.
// Les outils NetsuRush sont fournis au CLI via le serveur MCP (mcpConfigPath, cf. defs mcpInjection).

const { spawn } = require('child_process');
const { parserFor } = require('./parsers');
const { t } = require('../../i18n');

/**
 * @param {{
 *   def:import('./types').RuntimeAgentDef, prompt:string, model?:string,
 *   mcpConfigPath?:string, cwd:string, env?:NodeJS.ProcessEnv,
 *   onEvent:(ev:any)=>void, extraArgs?:string[], allowedTools?:string[]
 * }} opts
 * @returns {{ child:import('child_process').ChildProcess, done:Promise<void> }}
 */
function startCliRun(opts) {
  const { def, prompt, model, mcpConfigPath, cwd, env, onEvent } = opts;
  // En tete : chez Codex une cle `-c` doit preceder la sous-commande, et le
  // prompt positionnel des autres reste le dernier argument.
  // Node retombe sur `process.cwd()` quand `cwd` vaut `undefined` : omettre le
  // dossier ferait donc SILENCIEUSEMENT revenir l'agent dans le depot. On refuse
  // au lieu de lancer, parce que la panne serait invisible jusqu'a ce qu'un
  // fichier bouge.
  if (!cwd) throw new Error('startCliRun: a working directory is required (never the repository)');
  const args = [...(opts.extraArgs || []), ...def.buildArgs({
    prompt, model, mcpConfigPath, cwd, allowedTools: opts.allowedTools,
  })];
  const child = spawn(def.bin, args, {
    // JAMAIS `process.cwd()`. Le core demarre dans le depot NetsuRush, donc le
    // defaut lachait un agent de code, tous droits ouverts, dans les sources de
    // l'utilisateur : il modifiait les fichiers directement au lieu de passer
    // par nos outils, ce qui declenchait le rechargement a chaud et redemarrait
    // l'application. L'appelant fournit un dossier confine, et son absence est
    // une erreur plutot qu'un repli dangereux.
    cwd,
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
        if (code && code !== 0) {
          const exited = t('agentCliExited', { agent: def.name || def.id, code });
          onEvent({ type: 'error', message: errTail.trim() ? `${exited}\n${errTail.trim()}` : exited });
        }
        onEvent({ type: 'done', stopReason: code ? 'error' : 'end' });
      }
      resolve();
    });
    child.on('error', (e) => {
      onEvent({ type: 'error', message: t('agentCliLaunchFailed', { agent: def.name || def.id, detail: String((e && e.message) || e) }) });
      onEvent({ type: 'done', stopReason: 'error' });
      resolve();
    });
  });

  return { child, done };
}

module.exports = { startCliRun };
