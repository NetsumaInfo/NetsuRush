// @ts-check
// Lecture d'un flux SSE depuis une Response fetch (Node 18+ global fetch). Découpe les trames sur la
// ligne vide, parse `event:` / `data:`, appelle onMessage({event,data}) par trame. Utilisé par les
// chemins BYOK (Anthropic / OpenAI) pour le streaming de tokens.

/**
 * @param {Response} res
 * @param {(m:{event:string|null, data:string})=>void} onMessage
 */
async function readSSE(res, onMessage) {
  const body = /** @type {any} */ (res.body);
  if (!body || typeof body.getReader !== 'function') {
    // Repli : pas de stream → lit tout le corps comme une seule trame data.
    const text = await res.text();
    for (const block of text.split('\n\n')) emit(block, onMessage);
    return;
  }
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      emit(block, onMessage);
    }
  }
  if (buf.trim()) emit(buf, onMessage);
}

/** @param {string} block @param {(m:{event:string|null,data:string})=>void} onMessage */
function emit(block, onMessage) {
  let event = null;
  const dataLines = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length) onMessage({ event, data: dataLines.join('\n') });
}

module.exports = { readSSE };
