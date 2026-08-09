// @ts-check
// Chemin BYOK Anthropic : appel HTTP direct à l'API Messages (zéro SDK), streaming SSE + boucle
// tool-use complète. La clé API est fournie en RAM par la session (jamais lue sur disque ici).
//
// Boucle : appel → stream texte + blocs tool_use → exécute les outils (runTool, avec permission) →
// renvoie les tool_result → recommence tant que stop_reason === 'tool_use'.

const { readSSE } = require('./sse');
const { toToolContent } = require('./format');
const { imageAttachment } = require('./image');
const { t } = require('../../i18n');

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * @param {{
 *   apiKey:string, model?:string, system?:string, maxTokens?:number,
 *   messages:Array<{role:'user'|'assistant', content:any}>,
 *   tools:any[],
 *   runTool:(name:string, input:any)=>Promise<any>,
 *   onEvent:(ev:any)=>void,
 *   signal?:AbortSignal,
 * }} opts
 */
async function runAnthropic(opts) {
  const { apiKey, system, tools, runTool, onEvent, signal } = opts;
  const model = opts.model || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens || 4096;
  const messages = opts.messages.slice();
  if (!apiKey) { onEvent({ type: 'error', message: `Anthropic: ${t('apiKeyMissing')}` }); onEvent({ type: 'done', stopReason: 'error' }); return; }

  let guard = 0;
  for (;;) {
    if (guard++ > 24) { onEvent({ type: 'error', message: t('tooManyToolCalls') }); break; }

    /** @type {any[]} */
    const assistantBlocks = [];
    let stopReason = null;
    /** @type {Map<number,{type:string,id?:string,name?:string,jsonBuf:string,text:string}>} */
    const blocks = new Map();

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model, max_tokens: maxTokens, stream: true,
          ...(system ? { system } : {}),
          messages,
          ...(tools && tools.length ? { tools } : {}),
        }),
      });
    } catch (e) {
      onEvent({ type: 'error', message: `réseau Anthropic : ${String((e && /** @type {any} */(e).message) || e)}` });
      break;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      onEvent({ type: 'error', message: `Anthropic ${res.status} : ${detail.slice(0, 500)}` });
      break;
    }

    await readSSE(res, ({ event, data }) => {
      if (data === '[DONE]') return;
      let m;
      try { m = JSON.parse(data); } catch { return; }
      const type = event || m.type;
      if (type === 'content_block_start') {
        const cb = m.content_block || {};
        blocks.set(m.index, { type: cb.type, id: cb.id, name: cb.name, jsonBuf: '', text: '' });
        if (cb.type === 'tool_use') onEvent({ type: 'status', label: `outil ${cb.name}` });
      } else if (type === 'content_block_delta') {
        const b = blocks.get(m.index);
        const d = m.delta || {};
        if (d.type === 'text_delta') { onEvent({ type: 'text', delta: d.text }); if (b) b.text += d.text; }
        else if (d.type === 'thinking_delta') onEvent({ type: 'thinking', delta: d.thinking });
        else if (d.type === 'input_json_delta' && b) b.jsonBuf += d.partial_json || '';
      } else if (type === 'message_delta') {
        if (m.delta && m.delta.stop_reason) stopReason = m.delta.stop_reason;
        if (m.usage) onEvent({ type: 'usage', inputTokens: 0, outputTokens: m.usage.output_tokens || 0, costUsd: 0 });
      } else if (type === 'error') {
        onEvent({ type: 'error', message: String((m.error && m.error.message) || 'erreur stream Anthropic') });
      }
    });

    // Reconstitue les blocs du tour assistant (texte + tool_use) pour l'historique.
    /** @type {Array<{id:string,name:string,input:any}>} */
    const toolCalls = [];
    for (const b of blocks.values()) {
      if (b.type === 'text') assistantBlocks.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') {
        let input = {};
        try { input = b.jsonBuf ? JSON.parse(b.jsonBuf) : {}; } catch { input = {}; }
        assistantBlocks.push({ type: 'tool_use', id: b.id, name: b.name, input });
        toolCalls.push({ id: b.id || '', name: b.name || '', input });
      }
    }
    if (assistantBlocks.length) messages.push({ role: 'assistant', content: assistantBlocks });

    if (stopReason !== 'tool_use' || !toolCalls.length) {
      onEvent({ type: 'done', stopReason: stopReason || 'end' });
      break;
    }

    // Exécute les outils demandés → renvoie les résultats au modèle.
    const results = [];
    for (const call of toolCalls) {
      onEvent({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      const r = await runTool(call.name, call.input);
      const ok = !(r && r.ok === false);
      onEvent({ type: 'tool_result', id: call.id, name: call.name, ok, content: r });
      // Fichier image dans le résultat (grab_still…) → joint en bloc image : le modèle VOIT l'image.
      const img = imageAttachment(r);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: img
          ? [{ type: 'text', text: toToolContent(r) },
             { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }]
          : toToolContent(r),
        ...(ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: 'user', content: results });
  }
}

module.exports = { runAnthropic, DEFAULT_MODEL };
