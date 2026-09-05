// The composition editor: paste code, watch it play, scrub it, adjust what it
// declares, then hand it to the node — in a browser, beside the node rather
// than inside it.
//
// Two previews, because they answer different questions and only one of them
// can be fast:
//
//   Live   — the composition itself, running in an iframe at the browser's own
//            frame rate. Nothing is captured, so it is as smooth here as it is
//            on the engine's own site, for exactly the same reason: it is the
//            same thing, a page playing.
//   Rendu  — the pixels the host will actually receive, one captured frame at
//            a time. A fresh 1080p frame costs ~300 ms and a cached one ~13 ms,
//            so this tab is for checking, not for watching.
//
// Applying edits the spool file the OpenFX node reads. Sending is a separate,
// explicit gesture: it stamps a revision file the node keys its cache on, so
// the node changes when asked rather than under the user's hands mid-edit.
//
// Loopback only. The port is published in the session descriptor so the node's
// Open Editor button can find it without configuration.

import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { buildStudioShim } from './studioShim.mjs';
import { PAGE } from './editorPage.mjs';
import { pickFolderNatively, probeNativePicker } from './nativePicker.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
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

/// The live document is the pasted page plus two injections, and the order
/// matters: the Studio shim has to run before the page's own scripts, because
/// they read `window.__hyperframes` during setup. The player goes last, since
/// it waits on the clock the shim publishes.
///
/// Body transparency is forced to match the capture path, which composites on
/// alpha. Without it the iframe's default white would make every transparent
/// composition look opaque here and transparent in the host.
function buildLiveDocument(source, variables) {
  const shim = buildStudioShim({ variables: variables ?? null });
  const head = `${shim}<style>html,body{background:transparent !important;margin:0}</style>`;

  let out;
  const headTag = source.match(/<head[^>]*>/i);
  if (headTag) {
    const at = headTag.index + headTag[0].length;
    out = source.slice(0, at) + head + source.slice(at);
  } else {
    out = head + source;
  }
  return out + PLAYER_SCRIPT;
}

/// Drives the clock the shim published, in real time, and mirrors it to the
/// editor page. Deliberately a plain rAF loop over `__hf.seek`: a GSAP seek is
/// cheap, and driving the clock rather than letting the timeline free-run keeps
/// the live tab and the scrubber talking about the same position.
const PLAYER_SCRIPT = /* html */ `
<script>
(function () {
  'use strict';
  var playing = true;
  var at = 0;

  function post(message) {
    try { parent.postMessage(message, '*'); } catch (error) {}
  }

  var startedAt = Date.now();
  (function poll() {
    if (window.__hf && typeof window.__hf.seek === 'function') return start();
    if (Date.now() - startedAt > 15000) {
      post({ type: 'hf-error', message: 'aucune composition jouable (window.__hf absent)' });
      return;
    }
    setTimeout(poll, 50);
  })();

  function start() {
    var duration = window.__hf.duration;
    post({ type: 'hf-ready', duration: duration });
    var last = performance.now();
    var seekFailed = false;
    requestAnimationFrame(function frame(now) {
      if (playing) {
        at += (now - last) / 1000;
        if (at > duration) at -= duration;
        // Guarded, and the loop continues either way. Unguarded, one throw
        // from seek() skipped the requestAnimationFrame below and killed
        // playback permanently and silently — the Live tab then looks like a
        // composition that simply does not move. Engine 0.8.21 made this more
        // likely by reporting runtime delivery errors instead of swallowing
        // them, so the player has to survive a seek that fails.
        try {
          window.__hf.seek(at);
          seekFailed = false;
          post({ type: 'hf-time', t: at, duration: duration });
        } catch (error) {
          // Once per failing streak: a message every frame is 60 a second.
          if (!seekFailed) {
            seekFailed = true;
            playing = false;
            post({ type: 'hf-error', message: 'seek a echoue : ' + (error && error.message) });
          }
        }
      }
      last = now;
      requestAnimationFrame(frame);
    });
    addEventListener('message', function (event) {
      var message = event.data || {};
      if (message.type === 'hf-play') { playing = true; }
      else if (message.type === 'hf-pause') { playing = false; }
      else if (message.type === 'hf-seek') {
        at = Math.max(0, Math.min(Number(message.t) || 0, duration));
        window.__hf.seek(at);
      }
    });
  }
})();
</script>`;

/// Lists the folders inside one directory, plus the places worth starting from.
///
/// Only directories are returned: this exists to choose a destination, and a
/// listing of every file in Videos would be noise. Unreadable entries are
/// skipped rather than failing the listing, because one permission-denied
/// subfolder must not make the whole picker refuse to open.
function browseDirectory(requested) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  const shortcuts = [
    { label: 'Dossier personnel', path: home },
    { label: 'Bureau', path: join(home, 'Desktop') },
    { label: 'Vidéos', path: join(home, 'Videos') },
    { label: 'Documents', path: join(home, 'Documents') },
  ].filter((entry) => {
    try {
      return statSync(entry.path).isDirectory();
    } catch {
      return false;
    }
  });

  let path = typeof requested === 'string' && requested.trim() !== ''
    ? resolvePath(requested.trim())
    : home;

  // Walking up to something that exists beats an error: a typed path with one
  // wrong segment should still open its parent rather than nothing.
  let guard = 0;
  while (guard < 64) {
    try {
      if (statSync(path).isDirectory()) break;
    } catch {
      // fall through to the parent
    }
    const parent = dirname(path);
    if (parent === path) {
      path = home;
      break;
    }
    path = parent;
    guard += 1;
  }

  let entries = [];
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .filter((entry) => {
        try {
          return entry.isDirectory();
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('$') && !name.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, 'fr'))
      .slice(0, 500);
  } catch (error) {
    return { path, parent: dirname(path), entries: [], shortcuts, error: error.code ?? 'ERREUR' };
  }

  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, entries, shortcuts, error: null };
}

/**
 * @param {object} options
 * @param {string} options.spoolFile     the file the node reads
 * @param {() => object} options.status  current binding state, for the header
 * @param {(html: string, vars: object|null, size: object|null) => Promise<object>} options.onSave
 * @param {() => Promise<object>} options.onSend   hands the current spool to the node
 * @param {() => Promise<object>} options.onBake   renders every frame to disk
 * @param {() => Promise<object>} options.onBakeClear  empties the disk store
 * @param {(name: string) => Promise<object>} options.onBakeQuality  storage tier
 * @param {() => object} options.bakeProgress
 * @param {(frame: number) => Promise<object>} options.renderPng
 */
/// A fixed port, so a tab left open across a service restart keeps working.
/// Falling back to an ephemeral one rather than failing: another program may
/// legitimately hold it, and an editor on an odd port beats no editor.
const PREFERRED_PORT = 4318;

export async function startEditorServer({
  spoolFile, status, onSave, onSend, onBake, onBakeClear, onBakeQuality,
  bakeProgress, bakeDirectory,
  exportFormats, exportDefaults, onExport, exportProgress, onExportCancel,
  renderPng,
}) {
  let liveVariables = null;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(PAGE);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/live') {
        let source = '';
        try {
          source = readFileSync(spoolFile, 'utf8');
        } catch {
          source = '';
        }
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(source.trim() === '' ? '<!doctype html><title>vide</title>' : buildLiveDocument(source, liveVariables));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        let html = '';
        try {
          html = readFileSync(spoolFile, 'utf8');
        } catch {
          html = '';
        }
        sendJson(response, 200, { html, ...status() });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/save') {
        const { html, vars, width, height } = JSON.parse(await readBody(request));
        if (typeof html !== 'string' || html.trim() === '') {
          sendJson(response, 400, { error: 'le code est vide' });
          return;
        }
        liveVariables = vars ?? null;
        // A size is honoured only when both halves are sane. Half a size is a
        // typo mid-edit, and rebinding on it would reopen the browser at a
        // resolution nobody asked for.
        const size = Number.isInteger(width) && Number.isInteger(height) &&
          width >= 16 && height >= 16 && width <= 8192 && height <= 8192
          ? { width, height }
          : null;
        // The same shape `/api/state` answers, `html` included. It reads as the
        // state, so it has to BE the state: a caller that adopts this reply as
        // its state ends up holding a composition with no source otherwise —
        // which is exactly what happened to the NetsuRush panel.
        sendJson(response, 200, { html, ...(await onSave(html, vars ?? null, size)) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/send') {
        sendJson(response, 200, await onSend());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/bake') {
        sendJson(response, 200, await onBake());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/bake') {
        sendJson(response, 200, { ...bakeProgress(), directory: bakeDirectory });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/bake/quality') {
        const { quality } = JSON.parse(await readBody(request));
        const applied = await onBakeQuality(String(quality ?? ''));
        sendJson(response, 200, { ...applied, ...bakeProgress(), directory: bakeDirectory });
        return;
      }

      // Reclaim is automatic on every parameter change; this is the "give me
      // the space back now" button, so it is a separate verb rather than a
      // flag on the bake route.
      if (request.method === 'POST' && url.pathname === '/api/bake/clear') {
        const removed = await onBakeClear();
        // Nested, not spread: `bakeProgress()` has its own `frames` and
        // `bytes` — the ones left *after* the clear — and spreading both put
        // 0 where the amount reclaimed should be.
        sendJson(response, 200, { removed, ...bakeProgress(), directory: bakeDirectory });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/export') {
        sendJson(response, 200, {
          ...exportProgress(),
          formats: exportFormats,
          defaults: exportDefaults,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/export') {
        sendJson(response, 200, await onExport(JSON.parse(await readBody(request))));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/export/cancel') {
        sendJson(response, 200, onExportCancel());
        return;
      }

      // A directory picker, served rather than delegated. The browser's own
      // showDirectoryPicker hands back a handle, not a path, and a path is
      // exactly what the service needs in order to write there.
      if (request.method === 'GET' && url.pathname === '/api/browse') {
        sendJson(response, 200, {
          ...browseDirectory(url.searchParams.get('path')),
          native: await probeNativePicker() !== null,
        });
        return;
      }

      // The operating system's own chooser. Held open for as long as the user
      // takes; a cancel comes back as a null path, not as an error, because
      // closing a dialog is not a failure.
      if (request.method === 'POST' && url.pathname === '/api/browse/native') {
        const { path } = JSON.parse(await readBody(request));
        sendJson(response, 200, { path: await pickFolderNatively(path) });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/frame') {
        const frame = Math.max(0, Math.round(Number(url.searchParams.get('n') ?? 0)));
        const { png, opaque, partial } = await renderPng(frame);
        response.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          // The page cannot count alpha in a PNG it only draws, and a fully
          // transparent frame is indistinguishable from a broken one on screen.
          'x-opaque-pixels': String(opaque),
          'x-partial-alpha-pixels': String(partial),
        });
        response.end(png);
        return;
      }

      response.writeHead(404);
      response.end();
    } catch (error) {
      sendJson(response, 500, { error: error.code ? `${error.code}: ${error.message}` : error.message });
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') {
        reject(error);
        return;
      }
      server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise);
    });
    server.listen({ host: '127.0.0.1', port: PREFERRED_PORT }, resolvePromise);
  });

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(resolvePromise);
      }),
  };
}

