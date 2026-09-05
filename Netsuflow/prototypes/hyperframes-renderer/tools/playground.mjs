// Paste code in a box, get a render, tweak the declared parameters below it.
//
//   node tools/playground.mjs
//
// Launch it once; everything after happens in the browser. This is the shape
// the NetsuFlow tab in NetsuRush will take — standing alone here so the paste →
// render → adjust loop exists today, before the Tauri integration.
//
// One engine session at a time. Pasting new code or changing a parameter
// replaces the session; scrubbing reuses it, which is what makes the slider
// fast after the first frame.

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

import { HyperFramesEngine } from '../hyperframesEngine.mjs';
import { buildRuntimeManifest } from '../runtimeManifest.mjs';

const HERE = resolve(import.meta.dirname, '..');
const WORK = join(HERE, 'playground-work');
const PORT = Number(process.env.NETSUFLOW_PLAYGROUND_PORT ?? 4321);
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const engine = new HyperFramesEngine({
  chromePath: join(
    HERE,
    '.browser',
    'chrome-headless-shell',
    'win64-152.0.7977.54',
    'chrome-headless-shell-win64',
    'chrome-headless-shell.exe',
  ),
  enginePackageVersion: buildRuntimeManifest().engine.resolvedVersion,
});

let session = null;
let describeResult = null;
let revision = 0;

/// All engine work goes through one chain: a compose while a frame renders, or
/// two frames at once, would race the single browser page.
let queue = Promise.resolve();
function enqueue(work) {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

function attr(html, name) {
  const match = new RegExp(`${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`).exec(html);
  return match ? match[2] : null;
}

function detectStudio(html) {
  return (
    /<template[\s>]/i.test(html) ||
    /data-composition-variables/i.test(html) ||
    /__hyperframes/.test(html) ||
    /__timelines/.test(html)
  );
}

function declaredVariables(html) {
  const raw = attr(html, 'data-composition-variables');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function compose(html, vars) {
  if (session) {
    await session.close().catch(() => {});
    session = null;
    describeResult = null;
  }
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, 'index.html'), html, 'utf8');

  const width = Number(attr(html, 'data-width')) || 1920;
  const height = Number(attr(html, 'data-height')) || 1080;
  const fps =
    Number(attr(html, 'data-netsuflow-fps')) || Number(attr(html, 'data-fps')) || 30;
  const studio = detectStudio(html);
  revision += 1;

  session = await engine.open({
    id: `playground-${revision}`,
    projectRoot: WORK,
    compositionId: attr(html, 'data-composition-id') ?? 'playground',
    sourceRevision: String(revision),
    width,
    height,
    fps: { num: fps, den: 1 },
    studioCompat: studio,
    timelineMode: studio ? 'none' : 'auto',
    props: vars && Object.keys(vars).length > 0 ? vars : null,
  });
  describeResult = await session.describe();
  return {
    width,
    height,
    fps,
    studio,
    durationFrames: describeResult.durationFrames,
    durationSeconds: describeResult.durationSeconds,
    variables: declaredVariables(html),
    diagnostics: session.diagnostics ?? [],
  };
}

const CRC_TABLE = [];
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of typed) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typed, trailer]);
}
function encodePng(pixels, width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    pixels.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('composition too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/compose') {
      const { html, vars } = JSON.parse(await readBody(request));
      if (typeof html !== 'string' || html.trim() === '') {
        sendJson(response, 400, { error: 'le code est vide' });
        return;
      }
      const info = await enqueue(() => compose(html, vars ?? null));
      sendJson(response, 200, info);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/frame') {
      if (!session) {
        sendJson(response, 409, { error: 'aucune composition — colle du code et clique Rendre' });
        return;
      }
      const frame = Math.max(0, Math.round(Number(url.searchParams.get('n') ?? 0)));
      const rendered = await enqueue(() => session.renderFrame({ frame }));
      const png = encodePng(rendered.pixels, describeResult.width, describeResult.height);
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      response.end(png);
      return;
    }

    response.writeHead(404);
    response.end();
  } catch (error) {
    sendJson(response, 500, { error: error.code ? `${error.code}: ${error.message}` : error.message });
  }
});

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8" />
<title>NetsuFlow Playground</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: grid; grid-template-columns: minmax(320px, 34%) 1fr;
         font: 13px/1.45 system-ui, sans-serif; background: #131318; color: #d7d7e0; }
  #left { display: flex; flex-direction: column; border-right: 1px solid #26262e; min-width: 0; }
  #code { flex: 1; resize: none; border: 0; outline: 0; padding: 12px; background: #0d0d11;
          color: #cdd6f4; font: 12px/1.5 Consolas, monospace; white-space: pre; }
  #bar { display: flex; gap: 8px; align-items: center; padding: 10px 12px; background: #18181f; }
  button { border: 0; border-radius: 6px; padding: 8px 18px; font-weight: 600; cursor: pointer;
           background: #5a67f2; color: #fff; }
  button:disabled { background: #33334a; color: #888; cursor: default; }
  #status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            color: #9a9ab0; }
  #status.err { color: #ff7a90; }
  #right { display: flex; flex-direction: column; min-width: 0; }
  #view { flex: 1; display: grid; place-items: center; background:
          repeating-conic-gradient(#1a1a21 0 25%, #202029 0 50%) 0 0 / 24px 24px; min-height: 0; }
  #frame { max-width: 96%; max-height: 96%; box-shadow: 0 8px 40px #0009; }
  #scrub { display: flex; gap: 10px; align-items: center; padding: 10px 14px; background: #18181f; }
  #scrub input[type=range] { flex: 1; }
  #fno { width: 72px; text-align: right; color: #9a9ab0; font-variant-numeric: tabular-nums; }
  #params { max-height: 34%; overflow: auto; padding: 8px 14px 14px; background: #141419;
            border-top: 1px solid #26262e; }
  #params:empty { display: none; }
  .p { display: grid; grid-template-columns: 160px 1fr 70px; gap: 10px; align-items: center;
       padding: 6px 0; }
  .p label { color: #b8b8c8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .p input[type=text], .p select { background: #0d0d11; border: 1px solid #2c2c36; color: #d7d7e0;
       border-radius: 5px; padding: 6px 8px; width: 100%; }
  .p .val { color: #9a9ab0; text-align: right; font-variant-numeric: tabular-nums; }
  h3 { margin: 8px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
       color: #7a7a90; }
</style>
<div id="left">
  <textarea id="code" spellcheck="false"
    placeholder="Colle ton code ici — une page du catalogue HyperFrames ou la tienne — puis Rendre."></textarea>
  <div id="bar">
    <button id="render">Rendre</button>
    <span id="status">prêt</span>
  </div>
</div>
<div id="right">
  <div id="view"><img id="frame" alt="" /></div>
  <div id="scrub">
    <input id="slider" type="range" min="0" max="0" value="0" step="1" disabled />
    <span id="fno">–</span>
  </div>
  <div id="params"></div>
</div>
<script>
'use strict';
const codeBox = document.getElementById('code');
const renderBtn = document.getElementById('render');
const status = document.getElementById('status');
const img = document.getElementById('frame');
const slider = document.getElementById('slider');
const fno = document.getElementById('fno');
const paramsBox = document.getElementById('params');

let info = null;
let vars = {};
let frameTimer = null;

function say(text, isError) {
  status.textContent = text;
  status.className = isError ? 'err' : '';
}

async function compose() {
  renderBtn.disabled = true;
  say('démarrage de la session…');
  try {
    const reply = await fetch('/api/compose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: codeBox.value, vars }),
    });
    const data = await reply.json();
    if (!reply.ok) throw new Error(data.error || reply.statusText);
    info = data;
    slider.max = Math.max(0, data.durationFrames - 1);
    slider.disabled = false;
    buildParams(data.variables);
    say(data.width + 'x' + data.height + ' · ' + data.fps + ' fps · '
      + data.durationFrames + ' frames' + (data.studio ? ' · studio' : ''));
    await showFrame(Number(slider.value) || 0);
  } catch (error) {
    say(error.message, true);
  } finally {
    renderBtn.disabled = false;
  }
}

async function showFrame(n) {
  fno.textContent = n;
  const reply = await fetch('/api/frame?n=' + n);
  if (!reply.ok) {
    const data = await reply.json().catch(() => ({}));
    say(data.error || reply.statusText, true);
    return;
  }
  const blob = await reply.blob();
  const previous = img.src;
  img.src = URL.createObjectURL(blob);
  if (previous) URL.revokeObjectURL(previous);
}

function buildParams(declared) {
  paramsBox.innerHTML = '';
  if (!declared || declared.length === 0) return;
  const title = document.createElement('h3');
  title.textContent = 'Paramètres';
  paramsBox.appendChild(title);
  for (const entry of declared) {
    if (!entry || !entry.id) continue;
    const row = document.createElement('div');
    row.className = 'p';
    const label = document.createElement('label');
    label.textContent = entry.label || entry.id;
    label.title = entry.description || entry.id;
    row.appendChild(label);
    const current = Object.prototype.hasOwnProperty.call(vars, entry.id)
      ? vars[entry.id] : entry['default'];

    if (entry.type === 'enum' && Array.isArray(entry.options)) {
      const select = document.createElement('select');
      for (const option of entry.options) {
        const item = document.createElement('option');
        item.value = option.value;
        item.textContent = option.label || option.value;
        if (option.value === current) item.selected = true;
        select.appendChild(item);
      }
      select.onchange = () => setVar(entry.id, select.value);
      row.appendChild(select);
      row.appendChild(document.createElement('span'));
    } else if (entry.type === 'number') {
      const range = document.createElement('input');
      range.type = 'range';
      range.min = entry.min ?? 0;
      range.max = entry.max ?? 100;
      range.step = entry.step ?? 1;
      range.value = current ?? entry.min ?? 0;
      const value = document.createElement('span');
      value.className = 'val';
      value.textContent = range.value;
      range.oninput = () => { value.textContent = range.value; };
      range.onchange = () => setVar(entry.id, Number(range.value));
      row.appendChild(range);
      row.appendChild(value);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current == null ? '' : String(current);
      input.onchange = () => setVar(entry.id, input.value);
      row.appendChild(input);
      row.appendChild(document.createElement('span'));
    }
    paramsBox.appendChild(row);
  }
}

function setVar(id, value) {
  vars[id] = value;
  compose();
}

renderBtn.onclick = () => { vars = {}; compose(); };
slider.oninput = () => {
  fno.textContent = slider.value;
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => showFrame(Number(slider.value)), 90);
};
</script>`;

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  process.stdout.write(`NetsuFlow Playground: ${url}\n`);
  exec(`start "" "${url}"`);
});

process.on('SIGINT', () => {
  const closing = session ? session.close().catch(() => {}) : Promise.resolve();
  void closing.then(() => process.exit(0));
});
