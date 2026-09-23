// @ts-check
// Serializes a tool result to SEND BACK TO THE MODEL (not for the UI). Caps the size: a list (a Media
// Pool of 1000 clips, markers in bulk…) would swell the LLM context and cost useless tokens. It is
// cut to a character budget, and the model is told about the cut.
const MAX = 8000;

/** @param {any} r @param {number} [max] @returns {string} */
function toToolContent(r, max = MAX) {
  let s;
  try { s = typeof r === 'string' ? r : JSON.stringify(r); }
  catch { s = String(r); }
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[result truncated: ${s.length} characters in total]`;
}

module.exports = { toToolContent };
