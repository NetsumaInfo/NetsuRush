// Preview cache and preview GENERATION for every shot grid — Découpage, Timeline Live, Collections
// and Search all run this exact code.
//
// There used to be one copy per view, and they drifted: Timeline Live resolved thumbnails in idle
// chunks instead of one batch per file, its generation buttons reported no result, and it alone
// owned a destructive `invalidatePreviewRanges` that deleted proxies from disk and aborted a running
// generation whenever the timeline signature moved — which, on a LIVE timeline being edited in
// Resolve, is constantly. That is why "generate proxies" produced nothing there while the identical
// button worked in Découpage. No purge lives here: a proxy is keyed by its RANGE, so a clip that
// moves simply lands on a new key and the untouched ones keep their files.
//
// What a caller gets: an URL cache (with in-flight dedup), the two warm passes that fill it without
// encoding anything, and the two bounded generation pools behind the toolbar buttons.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { nr, nextProxyToken } from "@/lib/bridge";
import { getThumb, warmResolveThumbs } from "@/lib/thumbCache";
import { thumbTime } from "@/lib/utils";
import { previewSettingsFingerprint, PREVIEW_SETTINGS_EVENT } from "@/lib/previewSettings";
import { toast } from "@/components/ui/toast";

/** A shot as the preview pipeline sees it: a source file and a range in seconds. */
export interface PreviewRange { path: string; in: number; out: number }
/** Same, plus what lets the core seek by frame instead of by time when generating a thumbnail. */
export interface PreviewThumbRange extends PreviewRange { inFrame?: number; fps?: number }
/** Live counters of a generation run. `started - done` = requests in flight. */
export interface GenerationState { started: number; done: number; failed: number; total: number }

/** What a generation run works on. Pass a FUNCTION whenever the list can still change under it —
 *  Timeline Live paints the cached cuts of a timeline first and swaps them when the live read lands,
 *  so a run started on a plain array stays locked on the short, stale list while the grid above
 *  already shows every shot. A getter is re-read between shots: the run follows what is displayed,
 *  picks up what arrives late, and never touches what disappeared. */
export type PreviewSource<T> = T[] | (() => T[]);

function readSource<T>(source: PreviewSource<T>): T[] {
  return typeof source === "function" ? source() : source;
}

// The cell height comes from a ResizeObserver and from the density buttons, so callers re-arm the
// warm pass on every pixel of a resize. Each resolution reads the proxy directory core-side; a burst
// would hammer it exactly while the grid re-flows.
const WARM_PROXY_DEBOUNCE_MS = 150;
// `thumbsBatch` writes thumbnails to disk as it goes but does NOT return their paths. Without this
// poll each card would pull its own RPC while scrolling (HTTP sockets saturated → slow reveal); here
// the renderer cache is re-primed while the batch lands, and once more when it ends.
const WARM_THUMB_POLL_MS = 1500;
// Bounded pools, never `Promise.all` over 1400 shots: the browser would spread the fetches in waves
// and requests would leave AFTER "Stop", encoding anyway. A fixed worker count pulls shots one by
// one, so aborting leaves at most this many encodes to kill.
const PROXY_WORKERS = 6;
const THUMB_WORKERS = 8;

/** Cache key of a preview. The generation settings are part of it: changing them targets other
 *  files core-side, so an URL cached under the old settings must not be served. */
export function previewKey(path: string, start: number, end: number): string {
  return `${path}|${start.toFixed(3)}|${end.toFixed(3)}|${previewSettingsFingerprint()}`;
}

export interface PreviewCache {
  /** Generates (or fetches from cache) the preview proxy of a range. `token` makes it cancellable. */
  getProxy: (path: string, start: number, end: number, priority?: "high" | "low", height?: number, token?: number) => Promise<string | null>;
  /** SYNCHRONOUS read of the URL cache: a card mounts its <video> in its first render instead of
   *  waiting on a promise. */
  peekProxy: (path: string, start: number, end: number) => string | null;
  /** Drops one entry — a <video> that failed to decode falls back on the async path. */
  bustProxy: (path: string, start: number, end: number) => void;
  clearProxies: () => void;
  /** Resolves in ONE call the proxies ALREADY encoded (no ffmpeg, no queue). Without it a card
   *  cannot know its preview URL without asking the core, even for a file already on disk: it
   *  queues, rewrites its sidecar, then gets cancelled on the way out — hundreds of round-trips
   *  while scrolling, and the grid stays on its thumbnails. `height` must be the tier actually
   *  encoded (it is part of the core-side cache key). */
  warmProxies: (list: PreviewRange[], height?: number) => void;
  /** Fills the thumbnail cache for a whole grid: one resolve pass, then one batch per file. */
  warmThumbs: (list: PreviewThumbRange[]) => void;
  proxyGen: GenerationState | null;
  /** Toolbar button. Calling it again while it runs is the STOP. */
  generateProxies: (source: PreviewSource<PreviewRange>, height?: number) => Promise<void>;
  thumbsGen: GenerationState | null;
  /** Toolbar button (same STOP contract). CPU-bound core-side, so it runs alongside proxies (GPU). */
  generateThumbs: (source: PreviewSource<PreviewThumbRange>) => Promise<void>;
}

export function usePreviewCache(): PreviewCache {
  const { t } = useTranslation("derush");
  const cacheRef = useRef<Map<string, string> | null>(null);
  if (cacheRef.current === null) cacheRef.current = new Map();
  const cache = cacheRef.current;
  // A card and the side player can ask for the same shot in the same render: one promise owns the
  // encode and every consumer gets exactly the same result.
  const pendingRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const warmProxyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warmPollsRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const warmVersionRef = useRef(0);

  useEffect(() => () => {
    warmVersionRef.current++;
    if (warmProxyTimer.current) clearTimeout(warmProxyTimer.current);
    warmPollsRef.current.forEach((poll) => clearInterval(poll));
    warmPollsRef.current.clear();
  }, []);

  useEffect(() => {
    const clear = () => { cache.clear(); pendingRef.current.clear(); };
    window.addEventListener(PREVIEW_SETTINGS_EVENT, clear);
    return () => window.removeEventListener(PREVIEW_SETTINGS_EVENT, clear);
  }, [cache]);

  // Identités STABLES (useCallback) : ces fonctions entrent dans les dépendances des effets de
  // préchauffe des vues. Recréées à chaque rendu, elles relanceraient la résolution des proxies à
  // chaque sélection de carte — exactement la rafale que la préchauffe existe pour éviter.
  const getProxy = useCallback(async (
    path: string, start: number, end: number,
    priority: "high" | "low" = "high", height?: number, token?: number,
  ): Promise<string | null> => {
    const key = previewKey(path, start, end);
    const cached = cache.get(key);
    if (cached) return cached;
    const inFlight = pendingRef.current.get(key);
    if (inFlight) return inFlight;
    const request = nr.proxy({ input: path, start, end, priority, height, token })
      .then((r) => {
        if (!r.ok || !r.path) return null;
        const url = nr.assetUrl(r.path);
        cache.set(key, url);
        return url;
      })
      .finally(() => pendingRef.current.delete(key));
    pendingRef.current.set(key, request);
    return request;
  }, [cache]);

  const peekProxy = useCallback((path: string, start: number, end: number) => cache.get(previewKey(path, start, end)) ?? null, [cache]);
  const bustProxy = useCallback((path: string, start: number, end: number) => { cache.delete(previewKey(path, start, end)); }, [cache]);
  const clearProxies = useCallback(() => { cache.clear(); pendingRef.current.clear(); }, [cache]);

  const warmProxies = useCallback((list: PreviewRange[], height?: number) => {
    const missing = list.filter((s) => !cache.has(previewKey(s.path, s.in, s.out)));
    if (!missing.length) return;   // already resolved: leave without even arming the timer
    if (warmProxyTimer.current) clearTimeout(warmProxyTimer.current);
    warmProxyTimer.current = setTimeout(() => {
      warmProxyTimer.current = null;
      void nr.proxyResolve(missing.map((s) => ({ input: s.path, start: s.in, end: s.out })), { height })
        .then((rows) => {
          for (const row of rows) {
            if (!row.file) continue;
            const key = previewKey(row.input, row.start, row.end);
            // First write wins: a real playback may have filled the entry in the meantime.
            if (!cache.has(key)) cache.set(key, nr.assetUrl(row.file));
          }
        })
        .catch(() => { /* best-effort: cards fall back on on-demand encoding */ });
    }, WARM_PROXY_DEBOUNCE_MS);
    // Empty deps on purpose: `previewKey` reads the settings fingerprint AT CALL TIME, so the
    // closure stays correct. Listing it would re-arm the resolve on every parent render — that is,
    // on every card selection.
  }, [cache]);

  const warmThumbs = useCallback((list: PreviewThumbRange[]) => {
    if (!list.length) return;
    const version = ++warmVersionRef.current;
    const items = list.map((s) => ({ path: s.path, time: thumbTime(s.in, s.out) }));
    // Resolves in ONE RPC the thumbnails already on disk → primes the renderer cache, so cards
    // render their <img> without one RPC each.
    void warmResolveThumbs(items);
    // Each round only asks for what is STILL missing from the renderer cache: the core stats every
    // entry, so replaying the whole list of a several-hundred-shot grid every 1.5 s would pound the
    // disk exactly while scrolling.
    const pending = () => items.filter((it) => !getThumb(it.path, it.time));
    const poll = setInterval(() => {
      const missing = pending();
      if (missing.length) void warmResolveThumbs(missing);
    }, WARM_THUMB_POLL_MS);
    warmPollsRef.current.add(poll);
    // One batch per FILE: the core keeps one current batch per file (a newer one supersedes it), so
    // a grid spanning twenty sources warms them all at once instead of queueing behind one another.
    const byFile = new Map<string, PreviewThumbRange[]>();
    for (const shot of list) {
      const group = byFile.get(shot.path);
      if (group) group.push(shot); else byFile.set(shot.path, [shot]);
    }
    const batches = [...byFile].map(([path, group]) => nr.thumbsBatch(path, group.map((s) => {
      const time = thumbTime(s.in, s.out);
      return { time, frame: s.fps ? Math.round(time * s.fps) : (s.inFrame ?? 0) };
    })).catch(() => {}));
    void Promise.all(batches).finally(() => {
      clearInterval(poll);
      warmPollsRef.current.delete(poll);
      if (warmVersionRef.current !== version) return;   // another grid took over
      const missing = pending();
      if (missing.length) void warmResolveThumbs(missing);
    });
  }, []);

  // --- Generation buttons ---------------------------------------------------------------------
  // Both pools follow the same contract: a run is owned by a ref (state lags a click), re-calling
  // aborts, and the counters are published on every step so the button can show progress.

  const [proxyGen, setProxyGen] = useState<GenerationState | null>(null);
  const proxyRunRef = useRef<Promise<void> | null>(null);
  const proxyAbortRef = useRef(false);
  const proxyTokensRef = useRef<number[]>([]);

  // Pre-generates the preview proxies of every shot passed (or of the selection) at the SAME height
  // as the grid → autoplay reuses the files, instantly. Priority 'low': the core queue always yields
  // to hover and to the active shot. "Stop" raises the abort flag (no new fetch) and
  // `proxyCancelMany` kills the ≤6 encodes in flight.
  const generateProxies = useCallback(async (source: PreviewSource<PreviewRange>, height?: number): Promise<void> => {
    if (proxyRunRef.current) {   // already running -> the button is the STOP
      proxyAbortRef.current = true;
      nr.proxyCancelMany(proxyTokensRef.current);
      return;
    }
    if (!readSource(source).length) return;
    proxyAbortRef.current = false;
    proxyTokensRef.current = [];
    const run = (async () => {
      let done = 0, failed = 0, reused = 0;
      // Shots whose proxy was ALREADY there. Without this count, re-running over a fully cached list
      // flies through the bar and reports "proxies ready": nothing distinguishes "there was nothing
      // to do" from "it did nothing".
      let total = readSource(source).length;
      const claimed = new Set<string>();
      const publish = () => setProxyGen({ started: claimed.size, done, failed, total });
      // Next shot to handle, READ FROM THE CURRENT LIST — this is what ties the run to the count
      // shown above the grid instead of freezing it on the one that existed at click time.
      const nextShot = (): PreviewRange | null => {
        const current = readSource(source);
        total = current.length;
        for (const shot of current) {
          const key = previewKey(shot.path, shot.in, shot.out);
          if (claimed.has(key)) continue;
          claimed.add(key);
          return shot;
        }
        return null;
      };
      publish();
      // One pass = one request, plus ONE second attempt when it comes back empty. A shot can end up
      // without a proxy for reasons unrelated to the file: its request is shared with the card that
      // displays it (deduped by range), and that card cancels its own when it leaves the band, which
      // killed the pre-generation encode along the way. A hardware session refused for a moment is
      // caught the same way. Two bounded passes, never a loop.
      const encode = async (shot: PreviewRange): Promise<boolean> => {
        const token = nextProxyToken();
        proxyTokensRef.current.push(token);
        return !!await getProxy(shot.path, shot.in, shot.out, "low", height, token);
      };
      const worker = async () => {
        for (;;) {
          if (proxyAbortRef.current) return;
          const shot = nextShot();
          if (!shot) return;
          publish();
          if (peekProxy(shot.path, shot.in, shot.out)) reused++;
          try {
            let ok = await encode(shot);
            if (!ok && !proxyAbortRef.current) ok = await encode(shot);
            if (!ok) failed++;
          } catch { failed++; }
          done++; publish();
        }
      };
      await Promise.all(Array.from({ length: PROXY_WORKERS }, worker));
      if (proxyAbortRef.current) toast.info(t("cutStudio.genStopped", { done, total }));
      else if (failed) toast.error(t("cutStudio.genFailed", { failed, total }));
      else if (reused === done) toast.info(t("cutStudio.proxiesUpToDate", { count: done }));
      else toast.ok(t("cutStudio.proxiesReady", { count: done }));
    })();
    proxyRunRef.current = run;
    try { await run; } finally {
      if (proxyRunRef.current === run) proxyRunRef.current = null;
      setProxyGen(null);
      proxyAbortRef.current = false;
    }
  }, [getProxy, peekProxy, t]);

  const [thumbsGen, setThumbsGen] = useState<GenerationState | null>(null);
  const thumbsRunRef = useRef<Promise<void> | null>(null);
  const thumbsAbortRef = useRef(false);

  // Pre-generates the grid thumbnails. One `nr.thumbnail` per shot rather than a batch: a batch is
  // not cancellable, whereas here "Stop" simply stops issuing fetches. CPU-bound core-side
  // (thumbGate) so it runs AT THE SAME TIME as the proxy pool (GPU).
  const generateThumbs = useCallback(async (source: PreviewSource<PreviewThumbRange>): Promise<void> => {
    if (thumbsRunRef.current) { thumbsAbortRef.current = true; return; }   // re-click = STOP
    if (!readSource(source).length) return;
    thumbsAbortRef.current = false;
    const run = (async () => {
      let done = 0, failed = 0;
      let total = readSource(source).length;
      const claimed = new Set<string>();
      const seen: PreviewThumbRange[] = [];   // what was actually handled -> final cache priming
      const publish = () => setThumbsGen({ started: claimed.size, done, failed, total });
      // Same live read as the proxies: the list can still grow while the run works through it.
      const nextShot = (): PreviewThumbRange | null => {
        const current = readSource(source);
        total = current.length;
        for (const shot of current) {
          const key = `${shot.path}|${thumbTime(shot.in, shot.out).toFixed(3)}`;
          if (claimed.has(key)) continue;
          claimed.add(key);
          return shot;
        }
        return null;
      };
      publish();
      const worker = async () => {
        for (;;) {
          if (thumbsAbortRef.current) return;
          const shot = nextShot();
          if (!shot) return;
          publish();
          seen.push(shot);
          try {
            const result = await nr.thumbnail(shot.path, thumbTime(shot.in, shot.out));
            if (typeof result !== "string") failed++;
          } catch { failed++; }
          done++; publish();
        }
      };
      await Promise.all(Array.from({ length: THUMB_WORKERS }, worker));
      // The files are written but their paths never came back through `nr.thumbnail`: this final
      // resolve primes the renderer cache in one RPC, so mounted cards show their <img> without each
      // pulling its own request.
      await warmResolveThumbs(seen.map((s) => ({ path: s.path, time: thumbTime(s.in, s.out) })));
      if (thumbsAbortRef.current) toast.info(t("cutStudio.thumbsStopped", { done, total }));
      else if (failed) toast.error(t("cutStudio.thumbsFailed", { failed, total }));
      else toast.ok(t("cutStudio.thumbsReady", { count: done }));
    })();
    thumbsRunRef.current = run;
    try { await run; } finally {
      if (thumbsRunRef.current === run) thumbsRunRef.current = null;
      setThumbsGen(null);
      thumbsAbortRef.current = false;
    }
  }, [t]);

  return {
    getProxy, peekProxy, bustProxy, clearProxies, warmProxies, warmThumbs,
    proxyGen, generateProxies, thumbsGen, generateThumbs,
  };
}
