// This is a cache target, not a limit on visible playback. Dense screens reclaim
// paused decoders first; all visible cards still receive a start.
const MAX_PAUSED = 18;
const RETAINED_VIDEO_TARGET = 72;
let playing = 0;

function pausedCapacity(): number {
  return Math.max(0, Math.min(MAX_PAUSED, RETAINED_VIDEO_TARGET - playing));
}

function trimPausedVideos(): void {
  const room = pausedCapacity();
  while (retained.length > room) retained.shift()?.();
}

export function retainPlayingVideo(): () => void {
  playing++;
  trimPausedVideos();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    playing--;
    if (mountQueue.length) pumpMounts();
  };
}

const retained: (() => void)[] = [];

/** Keep a paused decoder available for a short scroll reversal. */
export function retainPausedVideo(release: () => void): () => void {
  retained.push(release);
  trimPausedVideos();
  return () => {
    const i = retained.indexOf(release);
    if (i >= 0) {
      retained.splice(i, 1);
      if (mountQueue.length) pumpMounts();
    }
  };
}

// One frame budget for visible starts AND speculative mounts. Two independent
// pumps used to create up to seven decoders in the same frame during scrolling.
const FRAME_MS = 1000 / 60;
const MOUNT_BURST = 3;

interface MountJob { order: number; priority: number; grant: () => void }

let mountQueue: MountJob[] = [];
let mountFrame: number | null = null;
let lastMountAt = 0;
let mountDirty = false;

function pumpMounts(): void {
  if (mountFrame != null || typeof requestAnimationFrame !== "function") return;
  mountFrame = requestAnimationFrame(() => {
    mountFrame = null;
    if (!mountQueue.length) { lastMountAt = 0; return; }
    const now = performance.now();
    const frameMs = lastMountAt ? now - lastMountAt : FRAME_MS;
    lastMountAt = now;
    const burst = frameMs > FRAME_MS * 2 ? 1 : frameMs > FRAME_MS * 1.2 ? 2 : MOUNT_BURST;
    // Visible requests precede every speculative request, regardless of row.
    if (mountDirty) {
      mountQueue.sort((a, b) => a.priority - b.priority || a.order - b.order);
      mountDirty = false;
    }
    let granted = 0;
    while (granted < burst) {
      // Do not create and immediately evict speculative decoders. The release
      // callbacks wake this queue when room returns; visible starts bypass it.
      if (mountQueue[0]?.priority === 1 && retained.length >= pausedCapacity()) break;
      const job = mountQueue.shift();
      if (!job) break;
      granted++;
      job.grant();
    }
    if (granted && mountQueue.length) pumpMounts();
    else lastMountAt = 0;
  });
}

function enqueueMount(order: number, priority: number, grant: () => void): () => void {
  const job: MountJob = { order, priority, grant };
  mountQueue.push(job);
  mountDirty = true;
  pumpMounts();
  return () => {
    const i = mountQueue.indexOf(job);
    if (i >= 0) mountQueue.splice(i, 1);
    if (!mountQueue.length && mountFrame != null) {
      cancelAnimationFrame(mountFrame);
      mountFrame = null;
      lastMountAt = 0;
    }
  };
}

export function requestPreloadMount(order: number, grant: () => void): () => void {
  return enqueueMount(order, 1, grant);
}

export function requestPlaybackStart(order: number, grant: () => void): () => void {
  return enqueueMount(order, 0, grant);
}
