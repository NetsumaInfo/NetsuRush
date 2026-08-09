// @ts-check
// Parsers de sortie des CLI agents → schéma d'événements NORMALISÉ commun (même vocabulaire que le
// chemin BYOK, consommé par la session puis l'UI) :
//   {type:'text', delta}            token de texte assistant
//   {type:'thinking', delta}        raisonnement (si exposé)
//   {type:'tool_use', id, name, input}
//   {type:'tool_result', id, name, ok, content}
//   {type:'status', label}
//   {type:'usage', inputTokens, outputTokens, costUsd}
//   {type:'done', stopReason}
//   {type:'error', message}
//
// Chaque ligne de sortie stream-json est un objet JSON COMPLET (pas de JSON partiel à recoller).

/** @param {string} line @returns {any[]} */
function parseClaudeStreamLine(line) {
  const t = line.trim();
  if (!t) return [];
  let msg;
  try { msg = JSON.parse(t); } catch { return []; }
  const out = [];
  // Delta de stream partiel (--include-partial-messages)
  if (msg.type === 'stream_event' && msg.event) {
    const ev = msg.event;
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta' && ev.delta.text) out.push({ type: 'text', delta: ev.delta.text });
      if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) out.push({ type: 'thinking', delta: ev.delta.thinking });
    }
    return out;
  }
  // Message assistant complet (blocs texte + tool_use)
  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    for (const b of msg.message.content) {
      if (b.type === 'text' && b.text) out.push({ type: 'text', delta: b.text });
      else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
    return out;
  }
  // Résultats d'outils (renvoyés par l'agent comme un message user)
  if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
    for (const b of msg.message.content) {
      if (b.type === 'tool_result') {
        out.push({
          type: 'tool_result',
          id: b.tool_use_id,
          name: '',
          ok: !b.is_error,
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
        });
      }
    }
    return out;
  }
  if (msg.type === 'system' && msg.subtype) {
    out.push({ type: 'status', label: msg.subtype });
    return out;
  }
  if (msg.type === 'result') {
    const u = msg.usage || {};
    out.push({ type: 'usage', inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, costUsd: msg.total_cost_usd || 0 });
    if (msg.is_error || msg.subtype === 'error_max_turns' || msg.subtype === 'error_during_execution') {
      out.push({ type: 'error', message: String(msg.result || msg.subtype || 'erreur agent') });
    }
    out.push({ type: 'done', stopReason: msg.subtype || 'end' });
    return out;
  }
  return out;
}

// Codex `exec --json` : NDJSON d'événements. Schéma variable selon version → on couvre les formes
// courantes (agent_message / reasoning / tool / item.* ) et on ignore le reste.
/** @param {string} line @returns {any[]} */
function parseCodexJsonLine(line) {
  const t = line.trim();
  if (!t) return [];
  let m;
  try { m = JSON.parse(t); } catch { return []; }
  const out = [];
  const node = m.item || m.msg || m;
  const kind = node.type || m.type || '';
  if (kind.includes('agent_message') || kind === 'message') {
    const text = node.text || node.message || (node.content && node.content[0] && node.content[0].text);
    if (text) out.push({ type: 'text', delta: text });
  } else if (kind.includes('reasoning') || kind.includes('thinking')) {
    const text = node.text || node.summary;
    if (text) out.push({ type: 'thinking', delta: text });
  } else if (kind.includes('command_execution') || kind.includes('tool')) {
    out.push({ type: 'tool_use', id: node.id || '', name: node.command || node.name || 'tool', input: node.args || node.input || {} });
  } else if (kind.includes('token_count') || kind.includes('usage')) {
    out.push({ type: 'usage', inputTokens: node.input_tokens || 0, outputTokens: node.output_tokens || 0, costUsd: 0 });
  } else if (kind === 'task_complete' || kind.includes('turn.completed') || kind === 'shutdown') {
    out.push({ type: 'done', stopReason: 'end' });
  } else if (kind.includes('error')) {
    out.push({ type: 'error', message: String(node.message || node.error || 'erreur codex') });
  }
  return out;
}

// Format texte brut (CLI sans sortie structurée) : chaque chunk = texte.
/** @param {string} chunk @returns {any[]} */
function parseTextChunk(chunk) {
  return chunk ? [{ type: 'text', delta: chunk }] : [];
}

/** @param {import('./types').StreamFormat} fmt */
function parserFor(fmt) {
  if (fmt === 'codex-json') return { mode: 'lines', fn: parseCodexJsonLine };
  if (fmt === 'text') return { mode: 'raw', fn: parseTextChunk };
  return { mode: 'lines', fn: parseClaudeStreamLine };
}

module.exports = { parseClaudeStreamLine, parseCodexJsonLine, parseTextChunk, parserFor };
