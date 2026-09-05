// The real renderer behind the existing bridge protocol.
//
// This is Task 6's claim made executable: the protocol, the session descriptor,
// the authentication, the length limits, and the C++ client were all built
// against the fake renderer — and none of them change when the frames start
// coming from a real engine. The protocol module is imported from the fake
// renderer on purpose: one wire format, two services, zero drift.
//
// The OpenFX plugin sends an opaque `binding` string. This server owns the
// mapping from that string to an engine session; the plugin never learns which
// engine answered, which is the entire architecture in one sentence.
//
// It listens on 127.0.0.1 only, never on 0.0.0.0.

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MessageReader, MessageType, encodeMessage } from '../fake-renderer/protocol.mjs';
import { frameKey, hashControlValues, hashProps, revisionKey } from './frameKey.mjs';
import { createFrameScheduler, SchedulerError } from './frameScheduler.mjs';
import { createFrameStore, BAKE_QUALITIES, DEFAULT_BAKE_QUALITY } from './frameStore.mjs';

const PROTOCOL_VERSION = 1;

/// FNV-1a 64 as lowercase hex, matching fnv1a64Hex in the C++ plugin byte for
/// byte. In Code mode the plugin sends this hash of its Code field as the
/// revision, and the service recognises the spool file by the same function.
export function fnv1a64Hex(text) {
  let hash = 14695981039346656037n;
  const bytes = Buffer.from(text, 'utf8');
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/// Decodes the HTML character references an attribute value carries.
///
/// Not optional, and the bug it fixes was visible on screen: an attribute is
/// entity-encoded in the source, and `getAttribute` in a browser returns it
/// decoded. Reading the same attribute with a regex does not. So a composition
/// declaring `"Hey what&#39;s the best tool"` fed the node that literal string,
/// the node offered it back as the variable's value, and the page rendered
/// `what&#39;s` — while the same composition left untouched rendered `what's`,
/// because then nothing overrode its own correctly-decoded default.
///
/// The five named references below are the ones XML/HTML guarantee; everything
/// else is numeric, which is what an authoring tool emits.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return text;
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Lone surrogates and out-of-range code points would throw; an
      // undecodable reference is left as written rather than losing the text.
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/// One declared variable, normalised.
///
/// The declaration is author-written and the node has to build a control from
/// it, so every field is either understood or replaced — never passed through
/// half-known. `type` is taken from a list of spellings authoring tools
/// actually emit, and inferred from the default when it is missing or
/// unrecognised, because a control the node cannot type is a control the user
/// cannot use.
const TYPE_ALIASES = new Map(Object.entries({
  string: 'string', text: 'string', str: 'string', content: 'string',
  number: 'number', float: 'number', double: 'number', int: 'number',
  integer: 'number', range: 'number', slider: 'number',
  color: 'color', colour: 'color', rgb: 'color', rgba: 'color',
  enum: 'enum', select: 'enum', choice: 'enum', option: 'enum', options: 'enum',
  boolean: 'boolean', bool: 'boolean', toggle: 'boolean', checkbox: 'boolean',
}));

/// Colour, in every spelling an author actually writes.
///
/// Recognising only `#rrggbb` was the reason a declared colour arrived as a
/// text box: `rgb(90,103,242)`, `hsl(...)` and `crimson` are all colours a
/// composition legitimately declares, and the control that can edit them is a
/// colour picker, not a string field. Everything is normalised to `#rrggbb`
/// with the alpha kept separately, because that is what both the picker and the
/// OpenFX RGB parameter can carry.
///
/// The named list is the full CSS set, packed as one string rather than 148
/// object literals: it is read once at startup, never per frame.
const CSS_COLOR_NAMES = (
  'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff ' +
  'beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 ' +
  'brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 ' +
  'cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b ' +
  'darkgoldenrod b8860b darkgray a9a9a9 darkgrey a9a9a9 darkgreen 006400 darkkhaki bdb76b ' +
  'darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 ' +
  'darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f ' +
  'darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff ' +
  'dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 ' +
  'forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 ' +
  'goldenrod daa520 gray 808080 grey 808080 green 008000 greenyellow adff2f honeydew f0fff0 ' +
  'hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa ' +
  'lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 ' +
  'lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgrey d3d3d3 ' +
  'lightgreen 90ee90 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa ' +
  'lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de ' +
  'lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 ' +
  'mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db ' +
  'mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a ' +
  'mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa ' +
  'mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 ' +
  'olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa ' +
  'palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 ' +
  'peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 ' +
  'red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 ' +
  'sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb ' +
  'slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f ' +
  'steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 ' +
  'violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32'
).split(' ');

const NAMED_COLORS = new Map();
for (let i = 0; i + 1 < CSS_COLOR_NAMES.length; i += 2) {
  NAMED_COLORS.set(CSS_COLOR_NAMES[i], '#' + CSS_COLOR_NAMES[i + 1]);
}

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const clamp255 = (value) => Math.max(0, Math.min(255, Math.round(value)));
const twoHex = (value) => clamp255(value).toString(16).padStart(2, '0');

/// hsl() to rgb, because a composition may declare either and a colour picker
/// speaks only one of them.
function hslToHex(h, s, l) {
  const sat = Math.max(0, Math.min(1, s));
  const light = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = light - c / 2;
  return '#' + twoHex((r + m) * 255) + twoHex((g + m) * 255) + twoHex((b + m) * 255);
}

/// Returns `{ hex, alpha }` for anything recognisable, or null.
export function parseColor(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (text === '') return null;
  if (text === 'transparent') return { hex: '#000000', alpha: 0 };

  const named = NAMED_COLORS.get(text);
  if (named) return { hex: named, alpha: 1 };

  if (HEX_PATTERN.test(text)) {
    const body = text.slice(1);
    if (body.length === 3 || body.length === 4) {
      const expand = (c) => c + c;
      const hex = '#' + expand(body[0]) + expand(body[1]) + expand(body[2]);
      const alpha = body.length === 4 ? parseInt(expand(body[3]), 16) / 255 : 1;
      return { hex, alpha };
    }
    const hex = '#' + body.slice(0, 6);
    const alpha = body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1;
    return { hex, alpha };
  }

  const functional = /^(rgba?|hsla?)\s*\(([^)]*)\)$/.exec(text);
  if (!functional) return null;
  // Comma and space separated forms both, since CSS Color 4 allows either.
  const parts = functional[2].split(/[\s,/]+/).filter((piece) => piece !== '');
  if (parts.length < 3) return null;

  const channel = (piece, scale) => {
    const value = Number.parseFloat(piece);
    if (!Number.isFinite(value)) return null;
    return piece.includes('%') ? (value / 100) * scale : value;
  };
  const alphaOf = (piece) => {
    if (piece === undefined) return 1;
    const value = Number.parseFloat(piece);
    if (!Number.isFinite(value)) return 1;
    return Math.max(0, Math.min(1, piece.includes('%') ? value / 100 : value));
  };

  if (functional[1].startsWith('rgb')) {
    const r = channel(parts[0], 255);
    const g = channel(parts[1], 255);
    const b = channel(parts[2], 255);
    if (r === null || g === null || b === null) return null;
    return { hex: '#' + twoHex(r) + twoHex(g) + twoHex(b), alpha: alphaOf(parts[3]) };
  }

  const h = Number.parseFloat(parts[0]);
  const sPercent = Number.parseFloat(parts[1]);
  const lPercent = Number.parseFloat(parts[2]);
  if (![h, sPercent, lPercent].every(Number.isFinite)) return null;
  return { hex: hslToHex(h, sPercent / 100, lPercent / 100), alpha: alphaOf(parts[3]) };
}

/// Text long enough that a single-line field is the wrong control. Measured
/// against the real paste: its explanations run past a hundred characters and
/// were being edited through a box showing about fifteen.
const MULTILINE_THRESHOLD = 60;

/// Mirrors kMaxVariables in openfx/src/Protocol.hpp. The two caps rose to 32
/// together; a lower one here silently strips the composition's tail variables
/// from the node while the editor still shows them.
export const MAX_WIRE_VARIABLES = 32;

/// A default like "16px" is a number wearing a suffix. Treating it as text
/// gives the Inspector a string field for what is really a size, and treating
/// it as a bare number sends the composition `16` where it expects `16px`.
/// So: numeric control, suffix remembered, suffix re-attached on the way back.
const SUFFIX_NUMBER = /^(-?\d+(?:\.\d+)?)(px|em|rem|%|vw|vh|vmin|vmax|ms|s|deg|fr|x)$/i;

function splitSuffixNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return { value, suffix: '' };
  if (typeof value !== 'string') return null;
  const match = SUFFIX_NUMBER.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? { value: number, suffix: match[2] } : null;
}

function inferType(value, hasOptions) {
  if (hasOptions) return 'enum';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    // Authoring tools that serialise through JSON.stringify twice ship their
    // booleans as text. "true" in a text field is a checkbox lost to a typo.
    if (text === 'true' || text === 'false') return 'boolean';
    if (parseColor(value) !== null) return 'color';
    if (splitSuffixNumber(value) !== null) return 'number';
  }
  return 'string';
}

function normaliseVariable(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') return null;

  const options = Array.isArray(raw.options)
    ? raw.options
        .map((option) => (
          typeof option === 'string'
            ? { value: option, label: option }
            : (option && typeof option === 'object' && option.value !== undefined
              ? { value: String(option.value), label: decodeEntities(String(option.label ?? option.value)) }
              : null)))
        .filter(Boolean)
    : [];

  const declared = typeof raw.type === 'string'
    ? TYPE_ALIASES.get(raw.type.trim().toLowerCase())
    : undefined;
  const fallback = raw['default'];
  const type = declared ?? inferType(fallback, options.length > 0);

  const out = {
    id: raw.id,
    type,
    label: decodeEntities(String(raw.label ?? raw.id)),
    description: decodeEntities(String(raw.description ?? '')),
    // The declaration's own grouping, so a composition with twenty variables
    // arrives sorted the way its author sorted it rather than as one long list.
    group: decodeEntities(String(raw.group ?? raw.role ?? '')),
  };

  if (type === 'number') {
    // The default and the bounds may each carry the suffix ("16px", min "0px"):
    // strip it everywhere the same way, or a suffixed min silently becomes NaN
    // and the repair below invents a range the author never wrote.
    const asNumber = (value) => {
      const split = splitSuffixNumber(value);
      return split ? split.value : Number(value);
    };
    const parsed = splitSuffixNumber(fallback);
    out['default'] = parsed ? parsed.value : 0;
    if (parsed && parsed.suffix) out.suffix = parsed.suffix;
    // A range with no bounds is a text box wearing a slider's clothes. When the
    // author gives none, a decade either side of the default is a usable range
    // and never a wrong one, since the value stays editable.
    const min = asNumber(raw.min);
    const max = asNumber(raw.max);
    out.min = Number.isFinite(min) ? min : Math.min(0, out['default']);
    out.max = Number.isFinite(max) ? max : Math.max(1, Math.abs(out['default']) * 2 || 1);
    if (out.max <= out.min) out.max = out.min + 1;
    const step = asNumber(raw.step);
    out.step = Number.isFinite(step) && step > 0 ? step : (out.max - out.min) / 100;
    const unit = typeof raw.unit === 'string' && raw.unit.trim() !== ''
      ? raw.unit.trim() : out.suffix;
    if (unit) out.unit = unit.slice(0, 8);
  } else if (type === 'boolean') {
    out['default'] = fallback === true || fallback === 'true' || fallback === 1;
  } else if (type === 'enum') {
    out.options = options;
    const value = fallback === undefined
      ? options[0]?.value
      : String(decodeEntities(String(fallback)));
    out['default'] = value ?? '';
  } else if (type === 'color') {
    // The author's own spelling is kept beside the normalised one: replacing
    // `crimson` with `#dc143c` in a composition that never asked for that is a
    // change nobody made, and only a touched control should change a value.
    const parsed = parseColor(typeof fallback === 'string' ? fallback : '');
    out['default'] = parsed ? parsed.hex : '#ffffff';
    out.alpha = parsed ? parsed.alpha : 1;
    if (typeof fallback === 'string') out.original = fallback.trim();
  } else {
    const text = fallback === undefined || fallback === null
      ? ''
      : decodeEntities(String(fallback));
    out['default'] = text;
    out.multiline = text.length > MULTILINE_THRESHOLD || text.includes('\n');
  }
  return out;
}

/// The variables a composition declares in data-composition-variables.
/// Attribute-regex rather than DOM on purpose: this runs against untrusted
/// pasted HTML in a plain Node process, and a parse failure must degrade to
/// "no variables", never to an exception.
export function declaredVariables(html) {
  const match = /data-composition-variables\s*=\s*(['"])([\s\S]*?)\1/.exec(html);
  if (!match) return [];
  let parsed;
  try {
    // Parse first, decode the string values after — never the other way round.
    // Decoding first would turn a `&quot;` inside a value into a bare quote and
    // take the whole declaration down with it. Doing it per-value cannot: by
    // then the JSON structure is already established.
    //
    // This also decodes one case a browser cannot, which is fine: a browser
    // decodes the attribute before parsing, so a `&quot;` in a value breaks the
    // declaration in Studio too. Every declaration that works there works here.
    parsed = JSON.parse(match[2]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normaliseVariable).filter(Boolean);
}

/// Every size the pasted code asks for, most authoritative first.
///
/// A composition states its size in more than one place and not always the same
/// way: the stage element carries `data-width`/`data-height`, the head carries
/// a viewport meta, and the body usually pins itself in pixels. They normally
/// agree, and when they do not, the one the composition's own layout keys off
/// is the element attribute — so that is the order.
///
/// Offering these instead of guessing is the point. A component authored at
/// 1080x1920 rendered at 1920x1080 does not letterbox, it lays out wrong, and
/// the user should not have to read the source to find out what it wanted.
const SIZE_SOURCES = [
  {
    label: 'attribut data-width/data-height',
    find: (html) => {
      const width = /data-width\s*=\s*['"](\d{1,5})['"]/.exec(html);
      const height = /data-height\s*=\s*['"](\d{1,5})['"]/.exec(html);
      return width && height ? [Number(width[1]), Number(height[1])] : null;
    },
  },
  {
    label: 'meta viewport',
    find: (html) => {
      const meta = /<meta[^>]*name\s*=\s*['"]viewport['"][^>]*>/i.exec(html);
      if (!meta) return null;
      const width = /width\s*=\s*(\d{2,5})/i.exec(meta[0]);
      const height = /height\s*=\s*(\d{2,5})/i.exec(meta[0]);
      return width && height ? [Number(width[1]), Number(height[1])] : null;
    },
  },
  {
    label: 'style du body',
    find: (html) => {
      const body = /<body[^>]*style\s*=\s*(['"])([\s\S]*?)\1/i.exec(html);
      if (!body) return null;
      const width = /(?:^|[;\s])width\s*:\s*(\d{2,5})px/i.exec(body[2]);
      const height = /(?:^|[;\s])height\s*:\s*(\d{2,5})px/i.exec(body[2]);
      return width && height ? [Number(width[1]), Number(height[1])] : null;
    },
  },
];

export function requestedSizes(html) {
  const found = [];
  for (const source of SIZE_SOURCES) {
    let pair;
    try {
      pair = source.find(html);
    } catch {
      pair = null;
    }
    if (!pair) continue;
    const [width, height] = pair;
    if (!Number.isInteger(width) || !Number.isInteger(height)) continue;
    if (width < 16 || height < 16 || width > 16384 || height > 16384) continue;
    if (found.some((entry) => entry.width === width && entry.height === height)) continue;
    found.push({ width, height, source: source.label });
  }
  return found;
}

/// The size a composition is authored at: the first thing it asks for, or null
/// when it asks for nothing.
export function declaredSize(html) {
  const [first] = requestedSizes(html);
  return first ? { width: first.width, height: first.height } : null;
}


/// Only what the wire supports today. The engine can produce more; the service
/// refuses explicitly rather than converting silently, because a silent
/// conversion is a pixel policy nobody reviewed.
const SUPPORTED_PIXEL_FORMAT = 'RGBA8';
const SUPPORTED_ALPHA_MODE = 'straight';
const IDENTITY_RENDER_SCALE_PPM = 1_000_000;

function writeSessionDescriptor(path, descriptor) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(descriptor), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function errorMessage(requestId, code, retryable, detail) {
  const metadata = { code, retryable };
  if (detail) metadata.detail = detail;
  // Every refusal is logged, because the only other place it surfaces is the
  // host's Status field, which shows the generic "renderer service returned an
  // error" and not the reason. Diagnosing a manual Fusion session without this
  // line means guessing between six different refusals.
  process.stderr.write(`[refused] ${code}${detail ? `: ${detail}` : ''}\n`);
  return encodeMessage({ type: MessageType.ERROR, requestId, metadata });
}

/// Validates a FRAME request against the binding it names. Returns null when
/// the request is acceptable, otherwise the refusal to send.
function refuseFrameRequest(header, request, binding) {
  if (!binding) {
    return errorMessage(header.requestId, 'unknown-binding', false, `no binding named ${JSON.stringify(request.binding ?? null)}`);
  }
  if (request.pixelFormat !== SUPPORTED_PIXEL_FORMAT) {
    return errorMessage(header.requestId, 'unsupported', false, `pixelFormat ${request.pixelFormat} is not supported; use ${SUPPORTED_PIXEL_FORMAT}`);
  }
  if (request.alphaMode !== SUPPORTED_ALPHA_MODE) {
    return errorMessage(header.requestId, 'unsupported', false, `alphaMode ${request.alphaMode} is not supported; use ${SUPPORTED_ALPHA_MODE}`);
  }
  if ((request.renderScalePpm ?? IDENTITY_RENDER_SCALE_PPM) !== IDENTITY_RENDER_SCALE_PPM) {
    // Refusing is deliberate: honouring a proxy scale by rendering full-size
    // and calling it scaled would be silently wrong pixels.
    return errorMessage(header.requestId, 'unsupported', false, 'renderScalePpm other than 1000000 is not implemented yet');
  }
  if (request.width !== binding.width || request.height !== binding.height) {
    return errorMessage(header.requestId, 'bad-request', false,
      `request is ${request.width}x${request.height} but binding ${binding.id} is ${binding.width}x${binding.height}`);
  }
  if (typeof request.sourceRevision === 'string' && request.sourceRevision !== '' &&
      request.sourceRevision !== binding.sourceRevision) {
    // The client believes it is rendering a revision this service does not
    // have. Answering anyway would poison every cache keyed on that revision.
    return errorMessage(header.requestId, 'stale-revision', false,
      `client requested revision ${request.sourceRevision}, service has ${binding.sourceRevision}`);
  }
  return null;
}

/**
 * Starts the bridge service in front of a real engine.
 *
 * `engine` is anything with `open(binding) -> session` where the session has
 * `renderFrame({frame, deadlineMs})` and `close()` — the common adapter
 * contract. Tests inject a deterministic stub here; production passes a
 * `HyperFramesEngine`. The server never imports the engine package itself,
 * so the adapter boundary holds.
 *
 * @returns {Promise<{port:number, token:string, sessionFile:string,
 *                    stats:object, warm:(id:string)=>Promise<void>, close:()=>Promise<void>}>}
 */
export async function startBridgeServer({ engine, bindings, ...options } = {}) {
  if (!engine || typeof engine.open !== 'function') {
    throw new TypeError('an engine with open(binding) is required');
  }
  const bindingTable = new Map(Object.entries(bindings ?? {}));
  if (bindingTable.size === 0) throw new TypeError('at least one binding is required');
  for (const [id, binding] of bindingTable) binding.id = id;

  const capabilities = typeof engine.probe === 'function' ? await engine.probe() : {};

  /// The part of a frame's identity that comes from the binding rather than the
  /// request. Computed once per binding: hashing props on every frame would put
  /// a JSON walk on the hot path for a value that cannot change without the
  /// binding changing.
  /// bindingId -> the disk generation it is currently writing into. A binding
  /// that moves to a new generation makes every frame of the old one
  /// unreachable, and this is where that is noticed.
  const liveGenerations = new Map();

  /// Reclaims the generation a binding just left.
  ///
  /// This runs from `bindingIdentity` rather than from the five places that
  /// invalidate an identity, because those five places are a list that grows:
  /// the recompute is the one event every one of them has in common. Measured
  /// before it existed: each parameter change added 60 files and 474 MiB to a
  /// 60-frame 1080x1920 composition and removed nothing.
  function adoptGeneration(bindingId, generation) {
    const previous = liveGenerations.get(bindingId);
    if (previous === generation) return;
    liveGenerations.set(bindingId, generation);
    if (frameStore === null) return;

    // A generation another binding is still writing into is not superseded.
    if (previous !== undefined) {
      let sharedWith = false;
      for (const [otherId, otherGeneration] of liveGenerations) {
        if (otherId !== bindingId && otherGeneration === previous) sharedWith = true;
      }
      if (!sharedWith) {
        const dropped = frameStore.dropGeneration(previous);
        if (dropped.frames > 0) {
          process.stderr.write(`[bake] reclaimed ${dropped.frames} frames, `
            + `${(dropped.bytes / (1024 * 1024)).toFixed(0)} MiB\n`);
        }
      }
    }

    // Whatever a previous run left behind belongs to nobody: no live binding
    // can name it, and nothing will ever supersede it. It is only safe to say
    // that once every binding has claimed its own generation, so this waits.
    if (liveGenerations.size >= bindingTable.size) {
      const dropped = frameStore.dropExcept(liveGenerations.values());
      if (dropped.frames > 0) {
        process.stderr.write(`[bake] reclaimed ${dropped.generations} orphan generation(s), `
          + `${(dropped.bytes / (1024 * 1024)).toFixed(0)} MiB\n`);
      }
    }
  }

  function bindingIdentity(binding) {
    if (binding.__identity) return binding.__identity;
    const identity = {
      engineId: capabilities.engine ?? 'unknown',
      engineAdapterVersion: capabilities.adapterVersion ?? 'unknown',
      enginePackageVersion: capabilities.engineVersion ?? 'unknown',
      // The browser build belongs in the key for the same reason the engine
      // version does: a Chrome upgrade can change antialiasing, and H02 already
      // measured antialiased edges as the least stable pixels there are.
      browserBuild: capabilities.browserBuild ?? capabilities.chromePath ?? 'unknown',
      projectRevision: binding.sourceRevision,
      compositionId: binding.compositionId,
      propsRevision: binding.propsRevision ?? 'none',
      propsHash: hashProps(binding.props ?? null),
      // The plugin does not sample Fusion controls yet, so these are constants
      // rather than absent: a constant is honest about being unused, an absent
      // field would make two different control sets share a key later.
      controlSchemaRevision: binding.controlSchemaRevision ?? 'none',
      controlValuesHash: hashControlValues(binding.controlValues ?? null),
      colorPolicy: binding.colorPolicy ?? 'srgb',
      alphaPolicy: SUPPORTED_ALPHA_MODE,
      timelineMode: binding.timelineMode ?? 'auto',
      timelineGraceMs: binding.timelineGraceMs ?? 3000,
      startDeadlineMs: binding.startDeadlineMs ?? 20_000,
      // Studio compatibility changes what the page becomes before it is ever
      // seeked, so two bindings that differ only here are different sources.
      studioCompat: binding.studioCompat === true,
      studioDeadlineMs: binding.studioDeadlineMs ?? 10_000,
      capturePath: binding.capturePath ?? capabilities.defaultCapturePath ?? 'alpha',
    };
    binding.__identity = { fields: identity, revision: revisionKey(identity) };
    adoptGeneration(binding.id, binding.__identity.revision);
    return binding.__identity;
  }

  const token = options.token ?? randomBytes(32).toString('hex');
  const instanceId = options.instanceId ?? randomBytes(8).toString('hex');
  const sessionFile =
    options.sessionFile ??
    join(tmpdir(), `netsuflow-bridge-${process.pid}-${randomBytes(4).toString('hex')}`, 'session.json');

  const stats = { connections: 0, frames: 0, errors: 0, helloRejected: 0 };
  const sockets = new Set();

  /// bindingId -> { sessionPromise }. One session per binding; ordering and
  /// concurrency are the scheduler's job.
  const sessions = new Map();

  function sessionEntry(bindingId) {
    let entry = sessions.get(bindingId);
    if (!entry) {
      entry = { sessionPromise: null };
      sessions.set(bindingId, entry);
    }
    return entry;
  }

  /// Parses varCount/varN out of a FRAME request. Returns undefined when the
  /// client sent none (old clients), an object otherwise - including {} for an
  /// explicit "no variables", which must still clear a previous override.
  function readRequestVariables(request) {
    const count = Number(request.varCount);
    if (!Number.isFinite(count)) return undefined;
    const out = {};
    for (let i = 0; i < Math.min(count, MAX_WIRE_VARIABLES); i += 1) {
      const packed = request[`var${i}`];
      if (typeof packed !== 'string') continue;
      const split = packed.indexOf('');
      if (split <= 0) continue;
      const id = packed.slice(0, split);
      const raw = packed.slice(split + 1);
      try {
        out[id] = JSON.parse(raw);
      } catch {
        out[id] = raw;
      }
    }
    return out;
  }

  /// The node's controls flatten what the declaration typed: a Double slot for
  /// "16px" sends 16, an RGB slot for rgba(...) sends #rrggbb with the alpha
  /// gone. The declaration is the record of the shape the composition expects,
  /// so it is re-applied here, keyed by revision because that is exactly when
  /// the declaration can change.
  const declaredShapeCache = new Map();

  function declaredShapes(binding) {
    const revision = binding.sourceRevision ?? '';
    const cacheKey = binding.id + '\u001f' + revision;
    if (declaredShapeCache.has(cacheKey)) return declaredShapeCache.get(cacheKey);
    let byId = new Map();
    try {
      const entry = binding.spoolFile
        ?? join(resolve(binding.projectRoot), binding.entryPoint ?? 'index.html');
      for (const variable of declaredVariables(readFileSync(entry, 'utf8'))) {
        byId.set(variable.id, variable);
      }
    } catch {
      byId = new Map();
    }
    if (declaredShapeCache.size > 16) declaredShapeCache.clear();
    declaredShapeCache.set(cacheKey, byId);
    return byId;
  }

  function restoreDeclaredShapes(binding, variables) {
    if (variables === undefined || Object.keys(variables).length === 0) return variables;
    const shapes = declaredShapes(binding);
    const out = {};
    for (const [id, value] of Object.entries(variables)) {
      const shape = shapes.get(id);
      if (shape?.suffix && typeof value === 'number') {
        out[id] = value + shape.suffix;
      } else if (shape?.type === 'color' && typeof shape.alpha === 'number' && shape.alpha < 1
          && typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) {
        // The declared alpha survives a colour change from a control that only
        // carries RGB. rgba() is safe wherever the original was: the original
        // itself carried an alpha, so the composition already handles one.
        const r = parseInt(value.slice(1, 3), 16);
        const g = parseInt(value.slice(3, 5), 16);
        const b = parseInt(value.slice(5, 7), 16);
        out[id] = 'rgba(' + r + ', ' + g + ', ' + b + ', ' + shape.alpha + ')';
      } else {
        out[id] = value;
      }
    }
    return out;
  }

  async function closeSession(bindingId) {
    const entry = sessions.get(bindingId);
    if (!entry?.sessionPromise) return;
    const pending = entry.sessionPromise;
    entry.sessionPromise = null;
    try {
      const session = await pending;
      await session.close();
    } catch {
      // A session that failed to open has nothing to close.
    }
  }

  async function openSession(bindingId) {
    const entry = sessionEntry(bindingId);
    if (!entry.sessionPromise) {
      entry.sessionPromise = engine.open(bindingTable.get(bindingId)).catch((error) => {
        // A failed open must not poison the binding forever; the next request
        // retries from scratch.
        entry.sessionPromise = null;
        throw error;
      });
    }
    return entry.sessionPromise;
  }

  /// Frames already rendered, kept on disk between runs. Absent unless a
  /// directory was configured, and every read of it is allowed to fail: a
  /// missing or damaged baked frame means "render it", never "give up".
  const frameStore = options.bakeDirectory
    ? createFrameStore({
      directory: options.bakeDirectory,
      maxBytes: options.bakeBytes,
      quality: options.bakeQuality,
    })
    : null;

  /// One scheduler in front of every binding.
  ///
  /// Concurrency stays at 1 because one session drives one Chromium page, and
  /// two seeks in flight on one page is a race rather than parallelism. What
  /// the scheduler adds on top of that is the part T01 measured a need for:
  /// Resolve issued 21 render calls for one frame, so without deduplication and
  /// a cache that is 21 captures for one picture.
  const scheduler = createFrameScheduler({
    concurrency: 1,
    // A 1080p RGBA frame is 8.3 MiB, so 256 MiB holds about 30 of them — less
    // than two seconds at 24 fps. A service that pre-renders a whole
    // composition needs a bound sized for one, or it evicts the beginning
    // while still filling the end.
    cacheBytes: options.cacheBytes ?? 256 * 1024 * 1024,
    render: async ({ key, descriptor, revision }) => {
      // Disk before browser. A baked frame is a read; an unbaked one is a
      // ~300 ms capture. This is the entire difference between a host that can
      // play the composition and a host that cannot, and it belongs here rather
      // than in the client because the frame key — revision, size, props,
      // engine identity — is only assembled on this side.
      if (frameStore) {
        const baked = frameStore.read(key, revision);
        if (baked) return baked;
      }
      const session = await openSession(descriptor.bindingId);
      const frame = await session.renderFrame({
        frame: descriptor.frame, deadlineMs: descriptor.deadlineMs,
      });
      // Every captured frame is written, not only the ones a bake asked for.
      // The capture has already been paid for by the time we get here, so
      // declining to keep it only guarantees paying again — and it means
      // scrubbing around a composition leaves it progressively playable
      // instead of leaving nothing behind.
      if (frameStore) frameStore.write(key, frame, revision);
      return frame;
    },
  });

  /// Fills the cache with a whole composition, one frame at a time, at the
  /// priority that yields to anything the user is actually waiting for.
  ///
  /// This exists because of a measurement, not a hunch: a real pasted
  /// composition renders a fresh 1080p frame in ~297 ms, which caps playback at
  /// 3.4 fps, while a cached one comes back in 13 ms. The frames are not slow
  /// to serve — they are slow to make, once. Making them ahead of time is the
  /// only thing that turns this into playback, and it is the pre-render H03's
  /// mode decision already called for.
  const prefetching = new Map();
  /// Kept after the run ends so the editor can still report what happened; a
  /// progress bar that vanishes on completion cannot say whether it completed.
  const lastRun = new Map();

  function cancelPrefetch(bindingId) {
    const run = prefetching.get(bindingId);
    if (run) {
      run.cancelled = true;
      run.running = false;
      prefetching.delete(bindingId);
    }
  }

  function bakeProgress(bindingId) {
    const run = prefetching.get(bindingId) ?? lastRun.get(bindingId);
    return {
      running: Boolean(run?.running),
      done: run?.done ?? 0,
      total: run?.total ?? 0,
      error: run?.error ?? null,
      frames: frameStore?.count ?? 0,
      bytes: frameStore?.bytes ?? 0,
      generations: frameStore?.generationCount ?? 0,
      quality: frameStore?.quality ?? DEFAULT_BAKE_QUALITY,
      qualities: Object.keys(BAKE_QUALITIES),
      // The cap is now the only way the store can still grow — generations are
      // reclaimed, so what is left is one generation against its bound. Worth
      // showing, because a bake that stops early stopped for this reason.
      limit: frameStore?.maxBytes ?? 0,
      store: Boolean(frameStore),
    };
  }

  /// `force` runs the sweep even when the service was started without
  /// `--prefetch`: a bake is something the user asked for, not a background
  /// optimisation the service decided to attempt.
  function startPrefetch(bindingId, { force = false } = {}) {
    if (!options.prefetch && !force) return;
    cancelPrefetch(bindingId);
    const binding = bindingTable.get(bindingId);
    if (!binding) return;

    const run = { cancelled: false, done: 0, total: 0, running: true };
    prefetching.set(bindingId, run);
    lastRun.set(bindingId, run);

    void (async () => {
      let total;
      try {
        const session = await openSession(bindingId);
        total = (await session.describe()).durationFrames;
      } catch {
        run.running = false;
        prefetching.delete(bindingId);
        return;
      }
      if (!Number.isFinite(total) || total <= 0) {
        run.running = false;
        prefetching.delete(bindingId);
        return;
      }
      run.total = total;

      const identity = bindingIdentity(binding);
      let filled = 0;
      let consecutiveFailures = 0;
      for (let frame = 0; frame < total; frame += 1) {
        if (run.cancelled) return;
        try {
          await scheduler.request({
            key: frameKey({
              ...identity.fields,
              protocolVersion: PROTOCOL_VERSION,
              frame,
              width: binding.width,
              height: binding.height,
              renderScalePpm: IDENTITY_RENDER_SCALE_PPM,
              quality: 'preview',
              pixelFormat: SUPPORTED_PIXEL_FORMAT,
            }).key,
            revision: identity.revision,
            priority: 'prefetch',
            descriptor: { bindingId, frame, deadlineMs: 60_000 },
          });
          filled += 1;
          run.done = filled;
          consecutiveFailures = 0;
        } catch {
          // One failed frame is not a reason to abandon the rest: the user may
          // simply have changed the code mid-sweep. A run of them is: a
          // composition that cannot open a session fails on every frame, and
          // retrying each one reopens a browser it never gets to use.
          if (run.cancelled) return;
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            run.running = false;
            run.error = 'trois échecs consécutifs';
            prefetching.delete(bindingId);
            process.stderr.write(
              `[prefetch] ${bindingId}: stopped after ${consecutiveFailures} consecutive failures
`,
            );
            return;
          }
        }
      }
      run.running = false;
      if (!run.cancelled) {
        prefetching.delete(bindingId);
        process.stderr.write(`[prefetch] ${bindingId}: ${filled}/${total} frames cached\n`);
      }
    })();
  }

  const server = createServer((socket) => {
    stats.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A hostile or crashing client must not take the service down.
    socket.on('error', () => socket.destroy());
    socket.setNoDelay(true);

    let authenticated = false;
    const reader = new MessageReader();

    const send = (buffer) => {
      if (!socket.destroyed) socket.write(buffer);
    };

    const handle = async ({ header, metadata }) => {
      if (header.type === MessageType.HELLO) {
        if (metadata?.token !== token) {
          stats.helloRejected += 1;
          send(errorMessage(header.requestId, 'unauthenticated', false));
          socket.end();
          return;
        }
        authenticated = true;
        send(
          encodeMessage({
            type: MessageType.HELLO_OK,
            requestId: header.requestId,
            metadata: { protocolVersion: PROTOCOL_VERSION, serviceInstance: instanceId },
          }),
        );
        return;
      }

      if (!authenticated) {
        send(errorMessage(header.requestId, 'unauthenticated', false));
        socket.end();
        return;
      }

      if (header.type === MessageType.PING) {
        send(encodeMessage({ type: MessageType.PONG, requestId: header.requestId }));
        return;
      }

      if (header.type === MessageType.CANCEL) return;

      if (header.type === MessageType.DESCRIBE) {
        const binding = bindingTable.get(metadata?.binding);
        if (!binding) {
          send(errorMessage(header.requestId, 'unknown-binding', false,
            `no binding named ${JSON.stringify(metadata?.binding ?? null)}`));
          return;
        }
        // Flat metadata only: each variable is one varN key packing its fields
        // with 0x1F, the mirror of what BridgeClient::describeComposition reads.
        const reply = {
          binding: binding.id,
          width: binding.width,
          height: binding.height,
          revision: binding.sourceRevision,
        };
        let declared = [];
        try {
          const entry = join(resolve(binding.projectRoot), binding.entryPoint ?? 'index.html');
          const source = readFileSync(entry, 'utf8');
          declared = declaredVariables(source);
          // Reported separately from width/height on purpose: those are what the
          // service is bound to, which the editor can override, while this is
          // what the composition asks for. The node offers both as formats
          // because a portrait piece should stay portrait after someone has
          // been trying formats in the editor.
          const authored = declaredSize(source);
          if (authored) {
            reply.codeWidth = authored.width;
            reply.codeHeight = authored.height;
          }
        } catch {
          declared = [];
        }
        reply.varCount = Math.min(declared.length, MAX_WIRE_VARIABLES);
        for (let i = 0; i < reply.varCount; i += 1) {
          const v = declared[i] ?? {};
          // Commas separate options on the wire, so a comma inside a label
          // (never a value: values are identifiers) degrades to a space.
          const wireList = (pick) => (Array.isArray(v.options)
            ? v.options.map((option) => String(pick(option) ?? '').replace(/,/g, ' ')).join(',')
            : '');
          reply[`var${i}`] = [
            v.id ?? '', v.type ?? '', v.label ?? '',
            v['default'] === undefined ? '' : String(v['default']),
            v.min === undefined ? '' : String(v.min),
            v.max === undefined ? '' : String(v.max),
            v.step === undefined ? '' : String(v.step),
            wireList((option) => option?.value),
            // Fields 8 and 9 are new; the old plugin's parser stops at 8 and
            // never sees them, which is the compatibility story in one line.
            wireList((option) => option?.label),
            v.unit ?? '',
          ].join('');
        }
        send(encodeMessage({ type: MessageType.DESCRIBE_OK, requestId: header.requestId, metadata: reply }));
        return;
      }

      if (header.type !== MessageType.FRAME) {
        send(errorMessage(header.requestId, 'unsupported', false));
        return;
      }

      const request = metadata ?? {};
      const binding = bindingTable.get(request.binding);

      // A spooled binding treats a revision mismatch as "the plugin just wrote
      // new code": re-read the file, and if its hash is what the client claims,
      // adopt it. No watcher, no race - the mismatch IS the notification.
      if (binding?.spoolFile && typeof request.sourceRevision === 'string' &&
          request.sourceRevision !== '' && request.sourceRevision !== binding.sourceRevision) {
        try {
          const source = readFileSync(binding.spoolFile, 'utf8');
          const hash = fnv1a64Hex(source);
          if (hash === request.sourceRevision) {
            binding.sourceRevision = hash;
            // Always on for a spooled paste: the shim is a no-op for a page
            // that already exposes __hf, and the only thing that rescues one
            // exposing neither a timeline nor a clock.
            binding.studioCompat = true;
            binding.timelineMode = 'none';
            binding.props = null;
            delete binding.__identity;
            delete binding.__varsKey;
            cancelPrefetch(binding.id);
            await closeSession(binding.id);
            process.stderr.write(`[spool] adopted revision ${hash}\n`);
            startPrefetch(binding.id);
          }
        } catch (error) {
          process.stderr.write(`[spool] could not read ${binding.spoolFile}: ${error.message}\n`);
        }
      }

      // A spooled binding also lets the client choose the size, for the same
      // reason it lets it choose the revision: the composition is the client's,
      // and the size it should be laid out at is a property of the composition,
      // not of the timeline it happens to sit in. A portrait composition asked
      // for at 1920x1080 does not letterbox — it lays out wrong and the client
      // sees a crop, which is exactly the defect this repairs.
      if (binding?.spoolFile && Number.isInteger(request.width) && Number.isInteger(request.height) &&
          request.width > 0 && request.height > 0 &&
          (request.width !== binding.width || request.height !== binding.height)) {
        binding.width = request.width;
        binding.height = request.height;
        delete binding.__identity;
        cancelPrefetch(binding.id);
        await closeSession(binding.id);
        process.stderr.write(`[spool] adopted size ${request.width}x${request.height}\n`);
        startPrefetch(binding.id);
      }

      const refusal = refuseFrameRequest(header, request, binding);
      if (refusal) {
        stats.errors += 1;
        send(refusal);
        return;
      }

      // Per-request variables override the binding's props. A change means the
      // injected getVariables() answer changes, and that is baked into the page
      // at session start - so the session is rebuilt, not just the cache key.
      const requestVariables = restoreDeclaredShapes(binding, readRequestVariables(request));
      if (requestVariables !== undefined) {
        const varsKey = JSON.stringify(requestVariables);
        if (binding.__varsKey !== varsKey) {
          binding.__varsKey = varsKey;
          binding.props = Object.keys(requestVariables).length > 0 ? requestVariables : null;
          delete binding.__identity;
          cancelPrefetch(binding.id);
          await closeSession(binding.id);
          startPrefetch(binding.id);
        }
      }

      const identity = bindingIdentity(binding);
      let key;
      try {
        ({ key } = frameKey({
          ...identity.fields,
          protocolVersion: PROTOCOL_VERSION,
          frame: request.frame,
          width: request.width,
          height: request.height,
          renderScalePpm: request.renderScalePpm ?? IDENTITY_RENDER_SCALE_PPM,
          quality: request.quality ?? 'preview',
          pixelFormat: request.pixelFormat,
        }));
      } catch (error) {
        stats.errors += 1;
        send(errorMessage(header.requestId, 'bad-request', false, error.message));
        return;
      }

      let frame;
      try {
        frame = await scheduler.request({
          key,
          revision: identity.revision,
          // Resolve's own render is the caller; interactive is the only
          // priority the plugin can produce today.
          priority: request.quality === 'final' ? 'final' : 'interactive',
          descriptor: {
            bindingId: binding.id,
            frame: request.frame,
            deadlineMs: request.deadlineMs ?? 10_000,
          },
        });
      } catch (error) {
        stats.errors += 1;
        if (error instanceof SchedulerError) {
          send(errorMessage(header.requestId, 'busy', error.details?.retryable === true, `${error.code}: ${error.message}`));
          return;
        }
        // Engine failures reach the wire as explicit, typed errors. `retryable`
        // comes from the adapter's own classification, which reads the engine's
        // error taxonomy rather than matching message text.
        send(errorMessage(
          header.requestId,
          'render-failed',
          error?.retryable === true,
          `${error?.code ?? 'ENGINE_ERROR'}: ${error?.message ?? error}`,
        ));
        return;
      }

      // Same metadata shape as the fake renderer, deliberately: the client
      // cannot tell which service answered, and that is the proof.
      send(
        encodeMessage({
          type: MessageType.FRAME_OK,
          requestId: header.requestId,
          metadata: {
            width: frame.width,
            height: frame.height,
            stride: frame.stride,
            frame: request.frame,
            pixelFormat: frame.pixelFormat,
            alphaMode: frame.alphaMode,
            revision: binding.sourceRevision,
          },
          body: Buffer.isBuffer(frame.pixels) ? frame.pixels : Buffer.from(frame.pixels),
        }),
      );
      stats.frames += 1;
    };

    socket.on('data', (chunk) => {
      reader.push(chunk);
      let messages;
      try {
        messages = [...reader.drain()];
      } catch {
        socket.destroy();
        return;
      }
      // Sequential per connection, matching the fake service: one request at a
      // time keeps response ordering deterministic.
      void messages.reduce(
        (previous, message) => previous.then(() => handle(message)).catch(() => socket.destroy()),
        Promise.resolve(),
      );
    });
  });

  server.on('error', () => {});

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: options.port ?? 0 }, resolvePromise);
  });

  const { port } = server.address();
  // Kept so the editor's port can be added to it later without the descriptor
  // losing anything it already published.
  const descriptor = {
    protocolVersion: PROTOCOL_VERSION,
    instanceId,
    pid: process.pid,
    port,
    token,
    startedAt: new Date().toISOString(),
  };
  writeSessionDescriptor(sessionFile, descriptor);

  const close = async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    // Before the sessions: the scheduler settles anything still waiting, so no
    // caller is left on a promise whose session is about to disappear.
    await scheduler.close();
    for (const entry of sessions.values()) {
      if (!entry.sessionPromise) continue;
      try {
        const session = await entry.sessionPromise;
        await session.close();
      } catch {
        // A session that failed to open has nothing to close.
      }
    }
    sessions.clear();
    try {
      rmSync(dirname(sessionFile), { recursive: true, force: true });
    } catch {
      // A leftover temporary directory is not worth failing a run over.
    }
  };

  return {
    port,
    token,
    instanceId,
    sessionFile,
    stats,
    /// Cache and scheduling counters, so a run can report how much of its work
    /// it avoided rather than only how much it did.
    schedulerStats: scheduler.stats,
    get cacheBytes() {
      return scheduler.cacheBytes;
    },
    /// Drops every cached frame of a binding and abandons its in-flight work.
    /// A caller still waiting is rejected rather than served the old pixels.
    invalidate: (bindingId) => {
      const binding = bindingTable.get(bindingId);
      if (!binding) return { dropped: 0, aborted: 0 };
      return scheduler.invalidate(bindingIdentity(binding).revision);
    },
    /// Opens a binding's session before the first request needs it. The C++
    /// harness allows 5 s per request; a cold browser start can spend most of
    /// that, so a service that knows its bindings warms them at startup.
    warm: (bindingId) => openSession(bindingId).then(() => undefined),
    /// Starts (or restarts) the background sweep that makes playback possible.
    prefetch: (bindingId) => startPrefetch(bindingId),
    /// Sets how baked frames are stored. Every tier is lossless, so this
    /// trades encode time against size and never quality; frames already on
    /// disk keep the codec named in their own header and stay readable.
    setBakeQuality: (name) => ({
      quality: frameStore ? frameStore.setQuality(name) : DEFAULT_BAKE_QUALITY,
    }),
    /// Empties the disk store. Reclaim is automatic on every parameter change;
    /// this is for the case the user simply wants the space back now.
    clearBake: () => {
      if (!frameStore) return { frames: 0, bytes: 0, generations: 0 };
      const removed = frameStore.clear();
      // The generations map would otherwise still name directories that no
      // longer exist, and the next identity change would "supersede" nothing.
      liveGenerations.clear();
      return removed;
    },
    /// Renders every frame of a composition to the disk store, so the host can
    /// play it back at a read's cost rather than a capture's. Idempotent: an
    /// already-baked frame is a hit and costs nothing to sweep past.
    bake: (bindingId) => {
      // Baking without a store would render the whole composition and throw it
      // away, which looks identical from the outside until playback is still
      // slow. Refuse instead.
      if (!frameStore) throw new Error('no bake directory is configured');
      startPrefetch(bindingId, { force: true });
      return bakeProgress(bindingId);
    },
    bakeProgress: (bindingId) => bakeProgress(bindingId),
    /// What the binding's composition reports about itself.
    describeBinding: (bindingId) => openSession(bindingId).then((session) => session.describe()),
    /// Drops the current session so the next request rebuilds it. Used when the
    /// editor rewrites the composition under a live binding.
    reopen: async (bindingId) => {
      cancelPrefetch(bindingId);
      await closeSession(bindingId);
    },
    /// One frame through the same scheduler and cache the wire uses, so the
    /// editor and the node never disagree about a frame.
    renderFrame: async (bindingId, frame) => {
      const binding = bindingTable.get(bindingId);
      if (!binding) throw new Error(`no binding named ${JSON.stringify(bindingId)}`);
      const identity = bindingIdentity(binding);
      const result = await scheduler.request({
        key: frameKey({
          ...identity.fields,
          protocolVersion: PROTOCOL_VERSION,
          frame,
          width: binding.width,
          height: binding.height,
          renderScalePpm: IDENTITY_RENDER_SCALE_PPM,
          quality: 'preview',
          pixelFormat: SUPPORTED_PIXEL_FORMAT,
        }).key,
        revision: identity.revision,
        priority: 'interactive',
        descriptor: { bindingId, frame, deadlineMs: 60_000 },
      });
      return result.pixels;
    },
    /// Publishes the editor's port in the session descriptor so the node's
    /// Open Editor button can find it without being configured.
    setEditorPort: (editorPort) => {
      descriptor.editorPort = editorPort;
      writeSessionDescriptor(sessionFile, descriptor);
    },
    close,
  };
}

/// Stops the service the descriptor names, if it is still running and is not
/// this process. Killing the node process takes its browsers with it, because
/// the engine's browser manager is a child of it.
function takeOverFrom(sessionPath) {
  const path = sessionPath ??
    join(process.env.LOCALAPPDATA ?? tmpdir(), 'NetsuRush', 'netsuflow', 'session.json');
  let previous;
  try {
    previous = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return;
  }
  const pid = Number(previous?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 'SIGTERM');
    process.stderr.write(`[takeover] stopped the previous service, pid ${pid}
`);
  } catch {
    // Already gone, which is the normal case.
  }
}

// Manual use, for the C++ harness run:
//   node server.mjs --session <path> [--fixture diagnostic|user] [--binding harness]
// Or against a composition on disk:
//   node server.mjs --session <path> --project <folder> --size 1920x1080
//                   [--composition <id>] [--fps 30] [--binding harness]
// A page authored for HyperFrames Studio — a catalog component pasted in as-is —
// needs --studio, and its declared parameters are set with --var:
//   node server.mjs --session <path> --project <folder> --size 1920x1080 --studio
//                   --var accent=violet --var stroke_width=28
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { HyperFramesEngine } = await import('./hyperframesEngine.mjs');
  const { buildRuntimeManifest } = await import('./runtimeManifest.mjs');

  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const readArg = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };

  const fixture = readArg('--fixture', 'diagnostic');

  /// `--var accent=violet --var stroke_width=28`, matching the ids a catalog
  /// component declares in `data-composition-variables`. Values are parsed as
  /// JSON when they parse and kept as strings when they do not, so a number
  /// stays a number and a path with spaces needs no quoting gymnastics.
  const readVars = () => {
    const out = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== '--var') continue;
      const pair = args[i + 1] ?? '';
      const split = pair.indexOf('=');
      if (split <= 0) {
        process.stderr.write(`--var needs id=value, got ${JSON.stringify(pair)}
`);
        process.exit(2);
      }
      const id = pair.slice(0, split);
      const raw = pair.slice(split + 1);
      try {
        out[id] = JSON.parse(raw);
      } catch {
        out[id] = raw;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  };
  const bindingId = readArg('--binding', 'harness');
  // The full Chrome build, not chrome-headless-shell, and the reason is
  // Windows-specific rather than aesthetic: chrome-headless-shell.exe is a
  // CONSOLE-subsystem binary (PE subsystem 3, measured), so Windows hands every
  // process in its tree a console — inherited when the parent has one, freshly
  // allocated when it does not. A freshly allocated console is a visible
  // window. Both service-side fixes were tried and measured, and both left an
  // empty terminal titled `chrome-headless-shell.exe` on the desktop:
  // DETACHED_PROCESS (no console to inherit, so each child made its own — 13
  // conhost.exe plus 13 OpenConsole.exe) and CREATE_NO_WINDOW (a windowless
  // console that Chromium's own children did not inherit).
  //
  // chrome.exe is subsystem 2. Windows never allocates a console for it, so the
  // failure mode does not exist to be worked around. Same version, same engine;
  // headless is requested through Puppeteer. BeginFrame capture is Linux-only
  // anyway, so nothing on this platform wanted the shell binary.
  const chromePath = join(
    here,
    '.browser',
    'chrome',
    'win64-152.0.7977.54',
    'chrome-win64',
    'chrome.exe',
  );

  const bindingsByFixture = {
    diagnostic: {
      projectRoot: join(here, 'fixture-diagnostic'),
      compositionId: 'netsuflow-diagnostic',
      sourceRevision: 'rev-0',
      width: 320,
      height: 180,
      fps: { num: 30, den: 1 },
    },
    user: {
      projectRoot: join(here, 'fixture'),
      compositionId: 'netsuflow-fixture',
      sourceRevision: 'rev-0',
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
    },
  };
  // --project points the service at a composition on disk instead of one of the
  // two fixtures. The size is required and not guessed: the service refuses a
  // request whose size differs from the binding's, so a wrong guess here does
  // not render smaller, it fails every frame with `bad-request`.
  // --paste serves the spool directory the OpenFX node writes its Code field
  // into. The node's content hash is the revision, and the rehash-on-mismatch
  // path above is what picks up each new paste - no watcher involved.
  const pasteMode = args.includes('--paste');
  const spoolDir = join(
    process.env.LOCALAPPDATA ?? tmpdir(), 'NetsuRush', 'netsuflow', 'paste');

  const projectRoot = pasteMode ? spoolDir : readArg('--project', undefined);

  /// Studio authoring is detected, not declared. A page that keeps its content
  /// in a <template>, reads getVariables(), or declares composition variables
  /// is a Studio page, and asking the user to also say so is one more way for a
  /// paste to render nothing with no error. `--no-studio` forces it off.
  const detectStudio = (root) => {
    if (args.includes('--no-studio')) return false;
    if (args.includes('--studio')) return true;
    let source;
    try {
      source = readFileSync(join(resolve(root), readArg('--entry', 'index.html')), 'utf8');
    } catch {
      return false;
    }
    return /<template[s>]/i.test(source) ||
      /data-composition-variables/i.test(source) ||
      /__hyperframes/.test(source) ||
      /__timelines/.test(source);
  };
  if (pasteMode) {
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = join(spoolDir, 'index.html');
    let source = '';
    try {
      source = readFileSync(spoolFile, 'utf8');
    } catch {
      // The placeholder honours the engine contract on its own, so the
      // service comes up green before any code has ever been pasted.
      writeFileSync(spoolFile, [
        '<!doctype html><html><body style="margin:0;background:#101018">',
        '<div data-composition-id="paste" data-width="1920" data-height="1080"',
        ' data-composition-duration="1" data-no-timeline',
        ' style="width:1920px;height:1080px;display:grid;place-items:center;',
        'font:500 42px system-ui;color:#5a6478">Paste code into the NetsuFlow node</div>',
        '<script>window.__hf={duration:1,seek:function(t){window.__hf.currentTime=t}};</script>',
        '</body></html>',
      ].join(''), 'utf8');
      source = readFileSync(spoolFile, 'utf8');
    }
  }

  let binding;
  const studio = projectRoot === undefined ? false : detectStudio(projectRoot);
  if (projectRoot !== undefined) {
    // Paste mode serves whatever timeline the node sits in, so it defaults to
    // the common case instead of demanding a flag nobody will know to pass.
    const size = readArg('--size', pasteMode ? '1920x1080' : undefined);
    const match = /^(\d+)x(\d+)$/.exec(size ?? '');
    if (!match) {
      process.stderr.write('--project needs --size WIDTHxHEIGHT, matching the host resolution exactly\n');
      process.exit(2);
    }
    const fps = Number(readArg('--fps', '30'));
    if (!Number.isFinite(fps) || fps <= 0) {
      process.stderr.write(`--fps must be a positive number, got ${readArg('--fps', '30')}\n`);
      process.exit(2);
    }
    binding = {
      projectRoot: resolve(projectRoot),
      compositionId: readArg('--composition', 'netsuflow-user'),
      entryPoint: readArg('--entry', 'index.html'),
      // The OpenFX plugin hardcodes "0". Defaulting to anything else means
      // every frame is refused as stale-revision before a first frame exists.
      sourceRevision: readArg('--revision', '0'),
      // --studio mounts the template, answers getVariables(), and turns the
      // page's GSAP timeline into the seekable clock. Without it a
      // Studio-authored page renders an empty stage and reports nothing.
      studioCompat: studio,
      timelineMode: studio ? 'none' : 'auto',
      // Every --var becomes a prop, which is how a parameter change already
      // invalidates the cache without a new frame-key field.
      props: readVars(),
      width: Number(match[1]),
      height: Number(match[2]),
      fps: { num: fps, den: 1 },
    };
  } else {
    binding = bindingsByFixture[fixture];
  }
  if (!binding) {
    process.stderr.write(`unknown fixture: ${fixture}\n`);
    process.exit(2);
  }
  if (pasteMode) {
    const spoolFile = join(spoolDir, 'index.html');
    const source = readFileSync(spoolFile, 'utf8');
    binding.spoolFile = spoolFile;
    binding.sourceRevision = fnv1a64Hex(source);
    binding.studioCompat = true;
    binding.timelineMode = 'none';
    // The composition's own declared size wins over the 1920x1080 default.
    // Hardcoding the default here is what made a 1080x1920 portrait component
    // arrive cropped: it was laid out in a landscape viewport and the parts
    // that fell outside were simply never drawn.
    const declared = declaredSize(source);
    if (declared) {
      binding.width = declared.width;
      binding.height = declared.height;
    }
  }

  const engine = new HyperFramesEngine({
    chromePath,
    enginePackageVersion: buildRuntimeManifest().engine.resolvedVersion,
  });
  // Only one service may own the descriptor: a second one would take the port
  // the plugin is about to read while the first keeps its browser alive, and
  // the pair leaks a browser per launch. Measured the hard way — 37 stray
  // chrome-headless-shell processes after a session of restarts.
  takeOverFrom(readArg('--session', undefined));

  const server = await startBridgeServer({
    engine,
    bindings: { [bindingId]: binding },
    sessionFile: readArg('--session', undefined),
    // Paste mode is an editing loop, so it pre-renders by default and gets a
    // cache big enough to hold what it pre-renders: at 8.3 MiB a 1080p frame,
    // 1 GiB is about 120 frames, five seconds at 24 fps.
    prefetch: pasteMode ? !args.includes('--no-prefetch') : args.includes('--prefetch'),
    cacheBytes: Number(readArg('--cache-mb', pasteMode ? '1024' : '256')) * 1024 * 1024,
    // Disk is what makes host playback possible at all: memory holds about 120
    // 1080p frames, and a 15-second portrait composition is 894 of them.
    bakeDirectory: pasteMode && !args.includes('--no-bake') ? join(spoolDir, 'bake') : undefined,
    bakeBytes: Number(readArg('--bake-gb', '24')) * 1024 * 1024 * 1024,
    bakeQuality: readArg('--bake-quality', DEFAULT_BAKE_QUALITY),
  });
  // A broken composition must not take the service down: sessions open lazily
  // per request, and the next paste replaces the bad one. Warming is a latency
  // optimisation, never a startup requirement.
  try {
    await server.warm(bindingId);
  } catch (error) {
    process.stderr.write(`[warm] ${error.code ?? 'ERROR'}: ${error.message}\n`);
  }
  server.prefetch(bindingId);

  // The editor is only offered where there is a spool to edit. It rewrites the
  // same file the node reads, so Save needs no channel back to the plugin: the
  // next frame simply carries a different revision.
  let editor = null;
  if (pasteMode && !args.includes('--no-editor')) {
    const { startEditorServer } = await import('./editorServer.mjs');
    const { encodePng } = await import('./pngEncode.mjs');
    const { FORMATS, runExport, resolveFfmpeg } = await import('./export.mjs');
    const { existsSync: fileExists } = await import('node:fs');
    const spoolFile = join(spoolDir, 'index.html');

    // Probed once, at startup: a movie format offered on a machine with no
    // encoder is a button that fails after the user has waited for it.
    const ffmpegPath = resolveFfmpeg(readArg('--ffmpeg', undefined));
    const ffmpegAvailable = ffmpegPath !== 'ffmpeg' ? fileExists(ffmpegPath) : true;
    process.stderr.write(`[export] ffmpeg: ${ffmpegPath}\n`);

    const exportProgress = {
      running: false, cancelled: false, done: 0, total: 0, error: null, output: null,
    };

    const describeBinding = async () => {
      const source = readFileSync(spoolFile, 'utf8');
      let durationFrames = 0;
      try {
        durationFrames = (await server.describeBinding(bindingId)).durationFrames;
      } catch {
        durationFrames = 0;
      }
      return {
        width: binding.width,
        height: binding.height,
        fps: binding.fps.num / binding.fps.den,
        durationFrames,
        variables: declaredVariables(source),
        requested: requestedSizes(source),
        revision: binding.sourceRevision,
      };
    };

    editor = await startEditorServer({
      spoolFile,
      status: () => {
        const source = readFileSync(spoolFile, 'utf8');
        return {
          width: binding.width,
          height: binding.height,
          fps: binding.fps.num / binding.fps.den,
          durationFrames: binding.__durationFrames ?? 0,
          variables: declaredVariables(source),
          requested: requestedSizes(source),
        };
      },
      onSave: async (html, vars, size) => {
        writeFileSync(spoolFile, html, 'utf8');
        binding.sourceRevision = fnv1a64Hex(html);
        binding.studioCompat = true;
        binding.timelineMode = 'none';
        binding.props = vars && Object.keys(vars).length > 0 ? vars : null;
        binding.__varsKey = JSON.stringify(binding.props ?? {});
        // An explicit size from the editor wins; otherwise the composition's
        // own declaration does. Pasting a portrait component should not need a
        // second gesture to be seen whole.
        const chosen = size ?? declaredSize(html);
        if (chosen) {
          binding.width = chosen.width;
          binding.height = chosen.height;
        }
        delete binding.__identity;
        await server.reopen(bindingId);
        const described = await describeBinding();
        binding.__durationFrames = described.durationFrames;
        server.prefetch(bindingId);
        return described;
      },
      // Applying is a preview; sending is a decision. The node keys its frame
      // cache on this file, so writing it is what makes the node's next render
      // pick up the edit — and not writing it is what keeps the node steady
      // while the composition is still being typed at.
      onSend: async () => {
        const html = readFileSync(spoolFile, 'utf8');
        const revision = fnv1a64Hex(html);
        writeFileSync(join(spoolDir, 'revision.txt'), revision, 'utf8');
        // The node reads the size from the same handoff, so sending a portrait
        // composition into a landscape timeline no longer needs a second
        // gesture in the Inspector to be framed correctly.
        writeFileSync(join(spoolDir, 'size.txt'), `${binding.width}x${binding.height}`, 'utf8');
        return { revision, width: binding.width, height: binding.height };
      },
      onBake: async () => server.bake(bindingId),
      onBakeClear: async () => server.clearBake(),
      onBakeQuality: async (name) => server.setBakeQuality(name),
      bakeProgress: () => server.bakeProgress(bindingId),
      bakeDirectory: join(spoolDir, 'bake'),

      // The export is deliberately not the bake. The bake is a cache keyed by
      // frame hash that only this service can read; an export is a file the
      // user chose the name and format of, that another program opens.
      exportFormats: Object.entries(FORMATS).map(([key, format]) => ({
        key,
        label: format.label,
        detail: format.detail,
        available: !format.needsFfmpeg || ffmpegAvailable,
      })),
      exportDefaults: {
        directory: join(process.env.USERPROFILE ?? process.env.HOME ?? spoolDir,
          'Videos', 'NetsuFlow'),
        name: 'composition',
      },
      onExport: async (request) => {
        if (exportProgress.running) throw new Error('un export est déjà en cours');
        exportProgress.cancelled = false;
        const total = binding.__durationFrames ?? 0;
        if (!(total > 0)) throw new Error('la composition ne déclare aucune durée');
        void runExport({
          format: request.format,
          directory: request.directory,
          name: request.name,
          quality: request.quality,
          from: request.from ?? 0,
          to: Math.min(request.to ?? total - 1, total - 1),
          width: binding.width,
          height: binding.height,
          fps: binding.fps.num / binding.fps.den,
          renderFrame: (frame) => server.renderFrame(bindingId, frame),
          progress: exportProgress,
        }).catch(() => {
          // runExport already recorded the reason on the progress object, which
          // is where the editor reads it. Rethrowing here would only surface as
          // an unhandled rejection.
        });
        return { started: true, total };
      },
      exportProgress: () => ({ ...exportProgress, formatsNeedFfmpeg: !ffmpegAvailable }),
      onExportCancel: () => {
        exportProgress.cancelled = true;
        return { cancelled: true };
      },
      renderPng: async (frame) => {
        const pixels = await server.renderFrame(bindingId, frame);
        let opaque = 0;
        let partial = 0;
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i] === 255) opaque += 1;
          else if (pixels[i] > 0) partial += 1;
        }
        return { png: encodePng(pixels, binding.width, binding.height), opaque, partial };
      },
    });

    try {
      binding.__durationFrames = (await server.describeBinding(bindingId)).durationFrames;
    } catch {
      binding.__durationFrames = 0;
    }
    server.setEditorPort(editor.port);
    process.stderr.write(`[editor] http://127.0.0.1:${editor.port}/\n`);
  }

  process.stdout.write(`${JSON.stringify({ port: server.port, editorPort: editor?.port ?? 0, sessionFile: server.sessionFile })}\n`);
  process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
}
