// @ts-check
// Does this key actually work?
//
// A settings panel that shows "key set" is reporting that a string is not
// empty. It says nothing about whether the key is valid, whether the account
// has credit, whether the base URL points anywhere, or whether a corporate
// proxy is eating the request. Every one of those fails later, mid-answer,
// as an error the user cannot connect to what they typed.
//
// So this asks the provider. One cheap call, a short deadline, and the real
// answer: reachable and authorised, or the reason it is not.

const { t } = require('../i18n');

const PROBE_TIMEOUT_MS = 12_000;

/// The smallest request each API accepts. One token out, because the answer
/// being tested is the HTTP status, not the text.
const PROBES = {
  anthropic: (key) => ({
    url: 'https://api.anthropic.com/v1/messages',
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    },
  }),
  openaiCompatible: (key, baseUrl, model) => ({
    url: `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    },
  }),
};

/// A status turned into something a user can act on. "401" is not a diagnosis;
/// "the key was refused" is.
function explain(status, body) {
  if (status === 401 || status === 403) return { ok: false, reason: 'refused', detail: t('agentProbeKeyRefused') };
  if (status === 404) return { ok: false, reason: 'not-found', detail: t('agentProbeNotFound') };
  if (status === 429) {
    // The key is valid: the account is rate-limited or out of credit. Reporting
    // that as a bad key would send the user to regenerate a key that works.
    return { ok: true, reason: 'rate-limited', detail: t('agentProbeRateLimited') };
  }
  if (status >= 500) return { ok: false, reason: 'upstream', detail: t('agentProbeUpstream', { status }) };
  if (status >= 400) {
    const message = typeof body === 'string' ? body.slice(0, 160) : '';
    return { ok: false, reason: 'rejected', detail: message || t('agentProbeRejected', { status }) };
  }
  return { ok: true, reason: 'ok', detail: '' };
}

/**
 * @param {{ provider:string, key:string, baseUrl?:string, model?:string }} request
 * @returns {Promise<{ok:boolean, reason:string, detail:string, ms:number}>}
 */
async function probeProvider({ provider, key, baseUrl, model }) {
  if (!key) return { ok: false, reason: 'missing', detail: t('apiKeyMissing'), ms: 0 };

  /** @type {{url:string, init:any}|null} */
  let call = null;
  if (provider === 'anthropic') call = PROBES.anthropic(key);
  else if (provider === 'openai') {
    call = PROBES.openaiCompatible(key, baseUrl || 'https://api.openai.com/v1', model || 'gpt-5-codex');
  } else if (provider === 'openrouter') {
    call = PROBES.openaiCompatible(key, 'https://openrouter.ai/api/v1', model || 'anthropic/claude-sonnet-4.5');
  } else if (provider === 'xai') {
    call = PROBES.openaiCompatible(key, baseUrl || 'https://api.x.ai/v1', model || 'grok-4.6');
  }
  if (!call) return { ok: false, reason: 'unknown', detail: t('agentUnknownProvider', { provider }), ms: 0 };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(call.url, { ...call.init, signal: controller.signal });
    const body = response.ok ? '' : await response.text().catch(() => '');
    return { ...explain(response.status, body), ms: Date.now() - started };
  } catch (error) {
    const message = String((error && /** @type {any} */(error).message) || error);
    // A network failure is the one case where the key is not the suspect: an
    // offline machine, a blocked host, or a base URL pointing at nothing.
    return {
      ok: false,
      reason: /abort/i.test(message) ? 'timeout' : 'network',
      detail: /abort/i.test(message) ? t('agentProbeTimeout') : message.slice(0, 160),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { probeProvider, PROBE_TIMEOUT_MS };
