// @ts-check
// Numbers read from a host's text values (Resolve clip properties such as "FPS" or "Frames",
// timeline settings). Resolve prints them with a dot today, in every interface language, but a
// localized build or a regional format writing `23,976` or `12 345` must not turn into 23 or 12:
// the frame rate and the frame count drive every cut.

const NUMBER = /^\s*([+-]?)(\d+)(?:[.,](\d+))?/;
// A whole number grouped by thousands: `12 345`, `12,345`, `12.345`, `12'345`, with a no-break or a
// narrow no-break space as some locales print it.
const GROUPED = /^\s*([+-]?\d{1,3}(?:[ ,.'  ]\d{3})+)(?!\d)/;

/**
 * A decimal from host text, with either decimal mark: `23.976`, `23,976`, `29.97 fps`. Gives
 * exactly what `parseFloat` gives on the dot form, NaN when there is no number.
 * @param {unknown} value
 * @returns {number}
 */
function parseHostFloat(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '');
  const match = NUMBER.exec(text);
  if (!match) return parseFloat(text);
  return parseFloat(`${match[1]}${match[2]}${match[3] != null ? `.${match[3]}` : ''}`);
}

/**
 * A whole number from host text, thousands separators allowed: `12345`, `12,345`, `12 345`. Gives
 * exactly what `parseInt(value, 10)` gives on the plain form, NaN when there is no number.
 * @param {unknown} value
 * @returns {number}
 */
function parseHostInt(value) {
  if (typeof value === 'number') return Math.trunc(value);
  const text = String(value ?? '');
  const grouped = GROUPED.exec(text);
  if (grouped) return parseInt(grouped[1].replace(/[ ,.'  ]/g, ''), 10);
  return parseInt(text, 10);
}

module.exports = { parseHostFloat, parseHostInt };
