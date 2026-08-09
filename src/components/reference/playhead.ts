// Live playback position of the board's video/YouTube items, kept OUTSIDE React: the position moves
// dozens of times per second and pushing it through the store would re-render every item on the
// board. Players register a handle when they mount; the inspector polls the SELECTED item only (loop
// playhead) and seeks through the same handle while a loop bound is dragged (scrub preview).

export interface PlayerHandle {
  /** Absolute time in the media, in seconds (proxy offset already applied); null when unknown. */
  time(): number | null;
  /** Seek to an absolute media time, in seconds. */
  seek(t: number): void;
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

export function playerSeek(id: string, t: number): void {
  players.get(id)?.seek(Math.max(0, t));
}
