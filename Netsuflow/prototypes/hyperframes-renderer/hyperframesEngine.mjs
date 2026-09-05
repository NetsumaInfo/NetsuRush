// The only module in NetsuFlow that imports @hyperframes/engine.
//
// HyperFrames is pre-1.0 and published 371 versions by the day this was pinned,
// so the cost of an upgrade has to be one file's worth. Everything above this
// boundary — the bridge, the protocol, the cache, the OpenFX plugin — speaks the
// common engine contract in docs/04-engine-contract.md and knows nothing about
// capture sessions, browser leases, or `window.__hf`.
//
// The contract is the same one a future Remotion adapter implements:
//   probe()                     -> EngineCapabilities
//   open(binding)               -> EngineSession
//   session.describe()          -> CompositionDescriptor
//   session.renderFrame(request)-> EngineFrame
//   session.invalidate(next)    -> void
//   session.close()             -> void
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureAlphaPng,
  captureFrameToBuffer,
  classifyCaptureFailure,
  closeCaptureSession,
  createCaptureSession,
  getCapturePerfSummary,
  getCompositionDuration,
  initializeSession,
  initTransparentBackground,
  isMemoryExhaustionError,
  isTransientBrowserError,
} from '@hyperframes/engine';

import { decodePngToRgba, PixelError } from './pixel/pngToRgba.mjs';
import { startProjectServer } from './projectServer.mjs';
import { buildTimelineShim, DEFAULT_GRACE_MS } from './timelineShim.mjs';
import { buildStudioShim, DEFAULT_STUDIO_DEADLINE_MS } from './studioShim.mjs';

export const ADAPTER_VERSION = '0.1.0-prototype';

/// Two ways to get pixels out of a page, both measured rather than assumed.
///
/// `buffer` uses `captureFrameToBuffer`, the engine's own path, written for the
/// sequential encode pipeline. `alpha` initialises a transparent background once
/// per session and then captures per frame, which is the engine's documented
/// recommendation for many-frame sessions and avoids two CDP round-trips a
/// frame. H02 picks the default from measurement; the switch exists so the
/// question stays answerable.
export const CAPTURE_PATHS = Object.freeze(['buffer', 'alpha']);

/// Measured, not preferred. The two paths return byte-identical pixels, so this
/// was never a correctness choice, and the latency difference is inside
/// run-to-run noise (1080p p50 117 ms alpha against 126 ms buffer, p95 ranges
/// overlapping). What decides it is that NetsuFlow is a transparency workflow —
/// a Fusion generator whose output composites — and `initTransparentBackground`
/// once per session plus `captureAlphaPng` per frame is the path the engine
/// documents for transparent output. Choosing the path built for the job, at no
/// measured cost, beats choosing the other one and hoping.
export const DEFAULT_CAPTURE_PATH = 'alpha';

/// How long a session may take to start before it is called broken.
///
/// The engine's own default is 45 s, and a composition that throws during setup
/// spends all of it: measured, a deliberately broken fixture took 46 s to
/// report. Behind a Resolve render that is indistinguishable from a hang, which
/// is the same failure the timeline shim exists to prevent, in a different
/// place.
///
/// It is not free to lower. The same timeout also bounds the engine's wait for
/// a GSAP timeline, and that wait *warns* rather than throws when it expires —
/// so under `gsap` mode a short deadline silently captures a composition whose
/// animation has not been built. That is why this value is part of session
/// identity, and why `gsap` mode should raise it rather than accept the default.
export const DEFAULT_START_DEADLINE_MS = 20_000;

export class EngineError extends Error {
  constructor(code, message, { retryable = false, cause = undefined, details = {} } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

/// Maps an engine or browser failure onto the common taxonomy.
///
/// The engine exports its own classifiers, so this reads them rather than
/// matching on message text, which would break on the next release. What the
/// layers above need is a stable code and whether retrying is worth anything;
/// the original message stays in `cause` for the log and never reaches the
/// OpenFX plugin.
function normalizeEngineError(error, fallbackCode) {
  if (error instanceof EngineError) return error;
  if (error instanceof PixelError) {
    return new EngineError(error.code, error.message, { cause: error, details: error.details });
  }

  const message = error?.message ?? String(error);

  if (isMemoryExhaustionError(error)) {
    return new EngineError('SESSION_MEMORY_EXHAUSTED', message, { cause: error, retryable: true });
  }
  if (isTransientBrowserError(error)) {
    return new EngineError('SESSION_TRANSIENT', message, { cause: error, retryable: true });
  }

  // The readiness timeout is the single most common real failure, and it has a
  // specific cause worth naming rather than reporting as a generic timeout.
  if (/window\.__hf not ready/i.test(message)) {
    return new EngineError(
      'COMPOSITION_NOT_READY',
      'the composition never exposed window.__hf = { duration, seek }',
      { cause: error },
    );
  }

  let classified;
  try {
    classified = classifyCaptureFailure(error);
  } catch {
    classified = null;
  }

  return new EngineError(fallbackCode, message, {
    cause: error,
    details: classified ? { engineClassification: classified } : {},
  });
}

function assertBinding(binding) {
  if (!binding || typeof binding !== 'object') {
    throw new EngineError('BINDING_INVALID', 'a binding snapshot is required');
  }
  for (const field of ['id', 'projectRoot', 'compositionId', 'sourceRevision']) {
    if (typeof binding[field] !== 'string' || binding[field] === '') {
      throw new EngineError('BINDING_INVALID', `binding.${field} must be a non-empty string`);
    }
  }
  const { width, height, fps } = binding;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new EngineError('COMPOSITION_INVALID', 'binding must declare integer width and height');
  }
  if (!fps || !Number.isInteger(fps.num) || !Number.isInteger(fps.den) || fps.num < 1 || fps.den < 1) {
    throw new EngineError('COMPOSITION_INVALID', 'binding.fps must be a rational { num, den }');
  }
  const startDeadlineMs = binding.startDeadlineMs ?? DEFAULT_START_DEADLINE_MS;
  if (!Number.isFinite(startDeadlineMs) || startDeadlineMs < 1000 || startDeadlineMs > 300_000) {
    throw new EngineError(
      'BINDING_INVALID',
      `startDeadlineMs must be between 1000 and 300000 ms, got ${startDeadlineMs}`,
    );
  }
  const capturePath = binding.capturePath ?? DEFAULT_CAPTURE_PATH;
  if (!CAPTURE_PATHS.includes(capturePath)) {
    throw new EngineError('BINDING_INVALID', `capturePath must be one of ${CAPTURE_PATHS.join(', ')}`);
  }
}

/// Everything that decides what a session renders. Two bindings that agree here
/// can share one session; anything else needs a new one.
///
/// `timelineMode` and its grace belong in this list even though they look like
/// plumbing: `auto` can stop waiting for a timeline that `gsap` would have
/// waited for, and the two then produce different pixels for the same frame.
export function sessionIdentity(binding) {
  return JSON.stringify({
    engine: 'hyperframes',
    adapter: ADAPTER_VERSION,
    projectRoot: binding.projectRoot,
    entryPoint: binding.entryPoint ?? 'index.html',
    compositionId: binding.compositionId,
    sourceRevision: binding.sourceRevision,
    propsRevision: binding.propsRevision ?? null,
    width: binding.width,
    height: binding.height,
    fps: binding.fps,
    capturePath: binding.capturePath ?? DEFAULT_CAPTURE_PATH,
    timelineMode: binding.timelineMode ?? 'auto',
    timelineGraceMs: binding.timelineGraceMs ?? DEFAULT_GRACE_MS,
    // In identity because under `gsap` mode the engine's timeline wait warns
    // instead of throwing when it expires, so a shorter deadline can change the
    // pixels rather than merely change whether the session starts.
    startDeadlineMs: binding.startDeadlineMs ?? DEFAULT_START_DEADLINE_MS,
  });
}

export class HyperFramesEngine {
  #chromePath;
  #enginePackageVersion;

  constructor({ chromePath, enginePackageVersion = null } = {}) {
    if (typeof chromePath !== 'string' || chromePath === '') {
      // Never fall back to the engine's ~/.cache lookup: a packaged product
      // owns its runtime, and "whichever Chrome happened to be cached" is not
      // a build anyone can put in a report.
      throw new EngineError('ENGINE_MISCONFIGURED', 'chromePath is required and must be explicit');
    }
    this.#chromePath = chromePath;
    this.#enginePackageVersion = enginePackageVersion;
  }

  async probe() {
    return {
      engine: 'hyperframes',
      adapterVersion: ADAPTER_VERSION,
      engineVersion: this.#enginePackageVersion,
      supportsRandomFrames: true,
      supportsAlpha: true,
      supportsPreRender: false,
      supportsAudioPreRender: false,
      captureFormats: ['RGBA8'],
      capturePaths: [...CAPTURE_PATHS],
      // Measured, not assumed: BeginFrame is Linux-only, and its compositor does
      // not preserve alpha anyway, so an alpha workflow forces screenshot
      // capture on every platform.
      captureMode: 'screenshot',
      chromePath: this.#chromePath,
    };
  }

  async open(binding) {
    assertBinding(binding);
    const session = new HyperFramesSession(binding, { chromePath: this.#chromePath });
    await session._start();
    return session;
  }
}

class HyperFramesSession {
  #binding;
  #chromePath;
  #server = null;
  #capture = null;
  #scratch = null;
  #closed = false;
  #alphaReady = false;
  #diagnostics = [];
  #identity;

  constructor(binding, { chromePath }) {
    this.#binding = binding;
    this.#chromePath = chromePath;
    this.#identity = sessionIdentity(binding);
  }

  get identity() {
    return this.#identity;
  }

  get diagnostics() {
    return [...this.#diagnostics];
  }

  async _start() {
    const timelineMode = this.#binding.timelineMode ?? 'auto';
    const graceMs = this.#binding.timelineGraceMs ?? DEFAULT_GRACE_MS;
    const startDeadlineMs = this.#binding.startDeadlineMs ?? DEFAULT_START_DEADLINE_MS;

    let shim;
    try {
      shim = buildTimelineShim({ mode: timelineMode, graceMs });
    } catch (error) {
      throw new EngineError('BINDING_INVALID', error.message, { cause: error });
    }

    try {
      // Studio's shim runs first: it mounts the template and answers
      // getVariables(), and the timeline shim's grace is only meaningful once
      // the page that would register a timeline actually exists.
      const headScripts = [];
      if (this.#binding.studioCompat) {
        headScripts.push(
          buildStudioShim({
            deadlineMs: this.#binding.studioDeadlineMs ?? DEFAULT_STUDIO_DEADLINE_MS,
            // Studio variables ARE props: they are per-binding authored inputs
            // that change the pixels. Routing them through `props` means the
            // frame key already invalidates on a parameter change, with no new
            // key field to keep in step.
            variables: this.#binding.props ?? null,
          }),
        );
      }
      if (shim) headScripts.push(shim);

      this.#server = await startProjectServer({
        root: this.#binding.projectRoot,
        entryPoint: this.#binding.entryPoint ?? 'index.html',
        headScripts,
      });
    } catch (error) {
      throw normalizeEngineError(error, 'PROJECT_UNAVAILABLE');
    }

    // The engine requires an outputDir even when every frame is captured to a
    // buffer. Nothing should ever be written here on the live path, and close()
    // checks that nothing was.
    this.#scratch = mkdtempSync(join(tmpdir(), 'netsuflow-hf-'));

    try {
      this.#capture = await createCaptureSession(
        this.#server.url,
        this.#scratch,
        {
          width: this.#binding.width,
          height: this.#binding.height,
          fps: this.#binding.fps,
          format: 'png',
          deviceScaleFactor: 1,
        },
        null,
        // forceScreenshot because BeginFrame's compositor does not preserve
        // alpha. On Windows the mode resolves to screenshot regardless; saying
        // it explicitly keeps the behaviour identical if this ever runs on Linux.
        {
          chromePath: this.#chromePath,
          forceScreenshot: true,
          playerReadyTimeout: startDeadlineMs,
        },
      );
      // The engine's own timeout is the primary bound; this outer race covers a
      // hang anywhere else in start, which its timeout would not see.
      await Promise.race([
        initializeSession(this.#capture),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new EngineError(
                  'SESSION_START_TIMEOUT',
                  `the session did not start within ${startDeadlineMs} ms`,
                  { retryable: true },
                ),
              ),
            startDeadlineMs + 2000,
          ).unref?.(),
        ),
      ]);
    } catch (error) {
      // A session that failed to start still owns a server and a scratch
      // directory, and possibly a browser.
      await this.close().catch(() => {});
      throw normalizeEngineError(error, 'SESSION_START_FAILED');
    }

    await this.#collectTimelineDiagnostics(timelineMode, graceMs);
  }

  /// Reads back what the shim decided and records it.
  ///
  /// Marking a host is NetsuFlow choosing, on the user's behalf, to stop waiting
  /// for an animation that might still be coming. Measured: a timeline
  /// registering after the grace is captured before it exists, and nothing else
  /// reports it. So it is surfaced here, naming the mode that removes the
  /// deadline.
  async #collectTimelineDiagnostics(mode, graceMs) {
    if (mode === 'gsap') return;
    let report = null;
    try {
      report = await this.#capture.page.evaluate(() => window.__netsuflowTimelineShim ?? null);
    } catch {
      return;
    }
    if (!report || report.marked.length === 0) return;

    this.#diagnostics.push(
      `stopped waiting for a GSAP timeline on ${report.marked.join(', ')} after ${graceMs} ms. ` +
        'If this composition builds its animation asynchronously, its first frames may be captured ' +
        "before that animation exists; set timelineMode: 'gsap' to wait without a deadline.",
    );
  }

  #assertOpen() {
    if (this.#closed) throw new EngineError('SESSION_CLOSED', 'the session is closed');
  }

  async describe() {
    this.#assertOpen();
    let durationSeconds;
    try {
      durationSeconds = await getCompositionDuration(this.#capture);
    } catch (error) {
      throw normalizeEngineError(error, 'COMPOSITION_UNREADABLE');
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new EngineError(
        'COMPOSITION_INVALID',
        `composition reported a duration of ${durationSeconds}s`,
      );
    }

    const { num, den } = this.#binding.fps;
    return {
      id: this.#binding.compositionId,
      width: this.#binding.width,
      height: this.#binding.height,
      fpsNumerator: num,
      fpsDenominator: den,
      durationFrames: Math.round((durationSeconds * num) / den),
      durationSeconds,
    };
  }

  /// Renders one frame and returns canonical straight-alpha RGBA8.
  ///
  /// The deadline is enforced here regardless of what the engine does with it.
  /// The thread waiting on this belongs to Resolve, and T01 measured that
  /// Resolve never aborts a render on this node — so the deadline, not
  /// cancellation, is what protects it.
  async renderFrame(request) {
    this.#assertOpen();

    const { frame, deadlineMs = 10_000, signal } = request;
    if (!Number.isInteger(frame) || frame < 0) {
      throw new EngineError('FRAME_INVALID', `frame must be a non-negative integer, got ${frame}`);
    }
    if (signal?.aborted) {
      throw new EngineError('FRAME_ABORTED', 'the request was aborted before it started');
    }

    const { num, den } = this.#binding.fps;
    const seconds = (frame * den) / num;
    const capturePath = this.#binding.capturePath ?? DEFAULT_CAPTURE_PATH;
    const timings = {};

    const started = process.hrtime.bigint();
    let encoded;
    try {
      encoded = await withDeadline(
        this.#capture,
        () => this.#captureEncoded(capturePath, frame, seconds),
        deadlineMs,
        signal,
      );
    } catch (error) {
      throw normalizeEngineError(error, 'FRAME_CAPTURE_FAILED');
    }
    timings.captureMs = Number(process.hrtime.bigint() - started) / 1e6;

    const decodeStarted = process.hrtime.bigint();
    let decoded;
    try {
      decoded = decodePngToRgba(encoded, {
        expectedWidth: this.#binding.width,
        expectedHeight: this.#binding.height,
      });
    } catch (error) {
      throw normalizeEngineError(error, 'PIXEL_DECODE_FAILED');
    }
    timings.decodeMs = Number(process.hrtime.bigint() - decodeStarted) / 1e6;
    timings.encodedBytes = encoded.length;

    return {
      width: decoded.width,
      height: decoded.height,
      stride: decoded.stride,
      pixelFormat: 'RGBA8',
      alphaMode: 'straight',
      pixels: decoded.pixels,
      timings,
      diagnostics: this.diagnostics,
    };
  }

  async #captureEncoded(capturePath, frame, seconds) {
    if (capturePath === 'alpha') {
      if (!this.#alphaReady) {
        // Once per session: the alternative sets and restores the background
        // override on every call, which is two CDP round-trips a frame.
        await initTransparentBackground(this.#capture.page);
        this.#alphaReady = true;
      }
      // This path does not go through the engine's seek, so the page has to be
      // moved to the requested time first.
      await this.#capture.page.evaluate((t) => {
        if (window.__hf && typeof window.__hf.seek === 'function') window.__hf.seek(t);
      }, seconds);
      await this.#capture.page.evaluate(async () => {
        await window.__hfWaitForSeekCompletion?.();
      });
      return captureAlphaPng(this.#capture.page, this.#binding.width, this.#binding.height);
    }

    const { buffer } = await captureFrameToBuffer(this.#capture, frame, seconds);
    return buffer;
  }

  /// Applies a new binding revision, reusing the session when nothing that
  /// affects setup changed.
  async invalidate(next) {
    this.#assertOpen();
    assertBinding(next);
    if (sessionIdentity(next) === this.#identity) {
      // Only the fields the request already carries changed, so the warm page
      // is still correct and there is nothing to rebuild.
      this.#binding = next;
      return { reused: true };
    }
    throw new EngineError(
      'SESSION_REBUILD_REQUIRED',
      'the new binding changes session identity; open a new session',
      { details: { retryWithNewSession: true } },
    );
  }

  perfSummary() {
    if (this.#closed || !this.#capture) return null;
    try {
      return getCapturePerfSummary(this.#capture);
    } catch {
      return null;
    }
  }

  /// Releases everything, in an order that survives a partial start.
  ///
  /// `closeCaptureSession` releases the browser lease itself, idempotently, so
  /// the adapter must not also release it. The README shows a caller-owned
  /// lease; the pinned package does not work that way.
  async close() {
    if (this.#closed) return { alreadyClosed: true };
    this.#closed = true;

    const problems = [];
    let scratchFiles = [];

    if (this.#capture) {
      try {
        await closeCaptureSession(this.#capture);
      } catch (error) {
        problems.push(`capture session: ${error?.message ?? error}`);
      }
      this.#capture = null;
    }

    if (this.#server) {
      try {
        await this.#server.close();
      } catch (error) {
        problems.push(`project server: ${error?.message ?? error}`);
      }
      this.#server = null;
    }

    if (this.#scratch) {
      try {
        // Nothing should have been written here. If something was, the live
        // path is touching the disk and that is a finding, not housekeeping.
        scratchFiles = readdirSync(this.#scratch);
        rmSync(this.#scratch, { recursive: true, force: true });
      } catch (error) {
        problems.push(`scratch directory: ${error?.message ?? error}`);
      }
      this.#scratch = null;
    }

    return { alreadyClosed: false, problems, scratchFiles };
  }
}

/// Races an operation against a deadline and an abort signal.
///
/// The engine offers no cancellation for a capture in flight, so losing the
/// race does not stop the work — it stops the caller waiting on it. That is the
/// distinction that matters when the caller is a host render thread.
async function withDeadline(capture, operation, deadlineMs, signal) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new EngineError('FRAME_INVALID', `deadlineMs must be a positive number, got ${deadlineMs}`);
  }

  let timer;
  let onAbort;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new EngineError('FRAME_TIMEOUT', `frame exceeded ${deadlineMs} ms`, { retryable: true })),
          deadlineMs,
        );
      }),
      new Promise((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(new EngineError('FRAME_ABORTED', 'the request was aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
