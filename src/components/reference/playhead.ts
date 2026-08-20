// Live playback position of the board's video/YouTube items, kept OUTSIDE React: the position moves
// dozens of times per second and pushing it through the store would re-render every item on the
// board. Players register a handle when they mount; the inspector polls the SELECTED item only (loop
// playhead) and seeks through the same handle while a loop bound is dragged (scrub preview).

export interface PlayerHandle {
  /** Absolute time in the media, in seconds (proxy offset already applied); null when unknown. */
  time(): number | null;
  /**
   * Seek to an absolute media time, in seconds. `scrubbing` means the user is still dragging a
   * bound: the player must PREVIEW from what it already holds rather than fetch new media. A
   * streamed player that honours it stays responsive under a drag instead of queueing one network
   * request per pointer event.
   */
  seek(t: number, scrubbing?: boolean): void;
}

const players = new Map<string, PlayerHandle>();

/** Registers a player and returns the matching unregister (safe to call from an effect cleanup). */
export function registerPlayer(id: string, handle: PlayerHandle): () => void {
  players.set(id, handle);
  return () => {
    if (players.get(id) === handle) players.delete(id);
  };
}

export function playerTime(id: string): number | null {
  const t = players.get(id)?.time() ?? null;
  return t != null && Number.isFinite(t) ? t : null;
}

export function playerSeek(id: string, t: number, scrubbing = false): void {
  players.get(id)?.seek(Math.max(0, t), scrubbing);
}
