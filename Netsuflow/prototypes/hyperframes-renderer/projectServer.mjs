// Serves one project directory to one headless browser, and nothing else to
// anyone else.
//
// This exists instead of the engine's own `createFileServer`, which was
// measured in H01 and rejected: it binds every interface, so a user's project
// directory was reachable from the LAN, and one encoded-separator form escaped
// the served root on Windows. Both failures are regression cases in
// test/projectServer.test.mjs.
//
// The threat model is narrow but real. The directory contents are authored by
// whoever wrote the composition, the URL is reachable by anything running on
// the machine, and the process serving it sits behind a Resolve render thread.
// So: loopback only, a per-run token, containment checked after canonical
// resolution, bounded everywhere, and no method that changes anything.
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';

/// Explicit, and deliberately short. Anything not listed is served as an opaque
/// download rather than guessed at, because guessing is how a project file
/// becomes something the browser will execute.
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
});

const DEFAULT_LIMITS = Object.freeze({
  maxUrlLength: 2048,
  maxHeaderBytes: 16 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
});

function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function endWith(res, status, body = '') {
  // Every refusal looks the same from outside. Distinguishing "no such file"
  // from "outside the root" from "wrong token" would turn the server into a
  // filesystem oracle.
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/// Turns a request URL into a path inside the root, or null.
///
/// The containment check is the actual defence, not the decoding rules above
/// it: whatever a request encodes, the resolved absolute path either sits under
/// the canonical root or the request is refused. `sep` is part of the
/// comparison so a sibling directory sharing the root's name prefix cannot pass.
function resolveWithinRoot(canonicalRoot, relative) {
  if (relative === '') return null;
  // A NUL truncates paths in some syscalls; a raw separator or a drive letter
  // is never legitimate here. Refuse rather than normalise, since normalising
  // attacker input is what produced the bug this server exists to avoid.
  if (/[\0\\]/.test(relative) || /^[a-zA-Z]:/.test(relative)) return null;
  if (relative.split('/').some((part) => part === '..')) return null;

  const target = resolve(canonicalRoot, relative);
  if (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep)) return null;
  return target;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { unsatisfiable: true };

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { unsatisfiable: true };

  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return { unsatisfiable: true };
    start = Math.max(size - length, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

function injectScripts(html, headScripts, bodyScripts) {
  let out = html;
  if (headScripts.length > 0) {
    const payload = headScripts.join('\n');
    out = out.includes('<head>') ? out.replace('<head>', `<head>\n${payload}`) : `${payload}\n${out}`;
  }
  if (bodyScripts.length > 0) {
    const payload = bodyScripts.join('\n');
    out = out.includes('</body>') ? out.replace('</body>', `${payload}\n</body>`) : `${out}\n${payload}`;
  }
  return out;
}

/**
 * Starts the server and resolves once it is listening.
 *
 * Returns `{ origin, url, port, token, root, close }`. `url` is what the
 * capture session should navigate to: it carries the token and ends in a
 * slash, so the composition's relative assets resolve beneath it.
 */
export async function startProjectServer(options) {
  const {
    root,
    headScripts = [],
    bodyScripts = [],
    entryPoint = 'index.html',
    ...limitOverrides
  } = options;

  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  // realpath so a symlinked root is compared against what the filesystem will
  // actually open, not against the name we were handed.
  const canonicalRoot = await realpath(resolve(root));
  // Per run, so a URL that leaks into a log or a crash dump is useless later,
  // and so two concurrent sessions cannot read each other's projects.
  const token = randomBytes(16).toString('hex');
  const prefix = `/${token}/`;

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        endWith(res, 405, 'method not allowed');
        return;
      }
      if (!req.url || req.url.length > limits.maxUrlLength) {
        endWith(res, 414, 'uri too long');
        return;
      }

      // Collapse empty path segments. The engine builds its navigation URL as
      // `${serverUrl}/index.html`, so a serverUrl ending in a slash arrives
      // here as `//index.html`, whose leading slash would otherwise make
      // resolve() treat it as an absolute path and land outside the root. This
      // is safe to normalise: `..` is still refused and containment is still
      // checked afterwards.
      const rawPath = req.url.split('?')[0].split('#')[0].replace(/\/{2,}/g, '/');
      if (!rawPath.startsWith(prefix)) {
        endWith(res, 404, 'not found');
        return;
      }

      let relative;
      try {
        // Decoded exactly once. A second pass would make `%252e` behave like
        // `%2e`, which is the kind of accidental leniency traversal relies on.
        relative = decodeURIComponent(rawPath.slice(prefix.length));
      } catch {
        endWith(res, 404, 'not found');
        return;
      }
      if (relative === '' || relative.endsWith('/')) relative = `${relative}${entryPoint}`;

      const target = resolveWithinRoot(canonicalRoot, relative);
      if (!target) {
        endWith(res, 404, 'not found');
        return;
      }

      let real;
      let info;
      try {
        // realpath first: a symlink inside the root can still point outside it,
        // and only the resolved path says where the read will actually land.
        real = await realpath(target);
        if (real !== canonicalRoot && !real.startsWith(canonicalRoot + sep)) {
          endWith(res, 404, 'not found');
          return;
        }
        info = await stat(real);
      } catch {
        endWith(res, 404, 'not found');
        return;
      }

      if (!info.isFile()) {
        // Directories included: no listing, and no hint that one exists.
        endWith(res, 404, 'not found');
        return;
      }
      if (info.size > limits.maxFileBytes) {
        endWith(res, 413, 'file too large');
        return;
      }

      const contentType = contentTypeFor(real);
      const isEntry = real === resolve(canonicalRoot, entryPoint);
      const wantsInjection = isEntry && (headScripts.length > 0 || bodyScripts.length > 0);

      const baseHeaders = {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': wantsInjection ? 'none' : 'bytes',
      };

      if (wantsInjection) {
        // Rewriting and byte ranges cannot both be honest about length, and
        // only the entry point is ever rewritten.
        const handle = await open(real, 'r');
        try {
          const source = await handle.readFile('utf8');
          const body = Buffer.from(injectScripts(source, headScripts, bodyScripts), 'utf8');
          res.writeHead(200, { ...baseHeaders, 'Content-Length': body.length });
          if (req.method === 'HEAD') res.end();
          else res.end(body);
        } finally {
          await handle.close();
        }
        return;
      }

      const range = parseRange(req.headers.range, info.size);
      if (range?.unsatisfiable) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${info.size}` });
        res.end();
        return;
      }

      if (range) {
        const length = range.end - range.start + 1;
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Length': length,
          'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(real, { start: range.start, end: range.end }).pipe(res);
        return;
      }

      res.writeHead(200, { ...baseHeaders, 'Content-Length': info.size });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(real).pipe(res);
    } catch {
      // Never let a handler throw take the process down: this runs in the same
      // service that a Resolve render is waiting on.
      if (!res.headersSent) endWith(res, 500, 'internal error');
      else res.destroy();
    }
  });

  server.maxHeadersCount = 64;
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.maxRequestsPerSocket = 0;

  // Tracked so close() is immediate rather than waiting on keep-alive.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((ready, failed) => {
    server.once('error', failed);
    // 127.0.0.1 explicitly. Omitting the host is what made the engine's own
    // server answer on every interface.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', failed);
      ready();
    });
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    // No trailing slash: the engine appends `/index.html` to whatever it is
    // given, and relative assets in the page then resolve under `/<token>/`.
    url: `${origin}/${token}`,
    port,
    token,
    root: canonicalRoot,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((done) => server.close(done));
    },
  };
}
