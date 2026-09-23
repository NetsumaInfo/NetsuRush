// @ts-check
// Chemin BYOK OpenAI (GPT/Codex API) : Chat Completions HTTP direct (zéro SDK), streaming SSE +
// boucle tool-calling. Clé API fournie en RAM par la session. Compatible endpoints OpenAI-like
// (baseUrl surchargeable). Les outils sont au format function-calling (registry.toOpenAITools()).

const { readSSE } = require('./sse');
const { toToolContent } = require('./format');
const { imageAttachment } = require('./image');
const { t } = require('../../i18n');

const DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5-codex';

/**
 * @param {{
 *   apiKey:string, model?:string, baseUrl?:string, system?:string,
 *   messages:Array<{role:string, content:any, tool_call_id?:string, tool_calls?:any[], images?:Array<{mediaType:string,data:string}>}>,
 *   tools:any[],
 *   runTool:(name:string, input:any)=>Promise<any>,
 *   onEvent:(ev:any)=>void,
 *   signal?:AbortSignal,
 *   extraBody?:Record<string,any>,
 * }} opts
 */
async function runOpenAI(opts) {
  const { apiKey, system, tools, runTool, onEvent, signal } = opts;
  const model = opts.model || DEFAULT_MODEL;
  const base = opts.baseUrl || DEFAULT_BASE;
  if (!apiKey) { onEvent({ type: 'error', message: t('agentApiKeyMissingFor', { provider: 'OpenAI' }) }); onEvent({ type: 'done', stopReason: 'error' }); return; }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  // Forme « parts » d'OpenAI : `image_url` accepte une URL de donnees, ce qui
  // evite d'heberger l'image quelque part pour la montrer une fois.
  for (const m of opts.messages) {
    if (m && Array.isArray(m.images) && m.images.length) {
      messages.push({
        role: m.role,
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          })),
        ],
      });
    } else {
      messages.push(m);
    }
  }

  let guard = 0;
  for (;;) {
    if (guard++ > 24) { onEvent({ type: 'error', message: t('tooManyToolCalls') }); break; }

    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, stream: true, messages,
          // `reasoning_effort` chez OpenAI et xAI, `reasoning:{effort}` chez
          // OpenRouter : c'est l'appelant qui sait lequel, pas cette boucle.
          ...(opts.extraBody || {}),
          ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
        }),
      });
    } catch (e) {
      onEvent({ type: 'error', message: t('agentNetworkError', { provider: 'OpenAI', detail: String((e && /** @type {any} */(e).message) || e) }) });
      break;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      onEvent({ type: 'error', message: `OpenAI ${res.status}: ${detail.slice(0, 500)}` });
      break;
    }

    let content = '';
    let finishReason = null;
    /** @type {Map<number,{id:string,name:string,args:string}>} */
    const calls = new Map();

    await readSSE(res, ({ data }) => {
      if (data === '[DONE]') return;
      let m;
      try { m = JSON.parse(data); } catch { return; }
      const choice = m.choices && m.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (delta.content) { onEvent({ type: 'text', delta: delta.content }); content += delta.content; }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index || 0;
          let c = calls.get(i);
          if (!c) { c = { id: tc.id || '', name: '', args: '' }; calls.set(i, c); }
          if (tc.id) c.id = tc.id;
          if (tc.function) {
            if (tc.function.name) c.name = tc.function.name;
            if (tc.function.arguments) c.args += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    });

    const toolCalls = [...calls.values()];
    if (finishReason !== 'tool_calls' || !toolCalls.length) {
      if (content || !toolCalls.length) messages.push({ role: 'assistant', content });
      onEvent({ type: 'done', stopReason: finishReason || 'end' });
      break;
    }

    // Enregistre le tour assistant (avec les tool_calls) puis exécute chaque outil.
    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    });
    for (const c of toolCalls) {
      let input = {};
      try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = {}; }
      onEvent({ type: 'tool_use', id: c.id, name: c.name, input });
      const r = await runTool(c.name, input);
      const ok = !(r && r.ok === false);
      onEvent({ type: 'tool_result', id: c.id, name: c.name, ok, content: r });
      messages.push({ role: 'tool', tool_call_id: c.id, content: toToolContent(r) });
      // The 'tool' role only accepts text → the image (grab_still…) goes in a following user message.
      const img = imageAttachment(r);
      if (img) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `Image returned by the ${c.name} tool:` },
            { type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } },
          ],
        });
      }
    }
  }
}

module.exports = { runOpenAI, DEFAULT_MODEL };
