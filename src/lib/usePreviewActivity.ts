import { useEffect, useState, type RefObject } from "react";
import { observeViewport } from "@/lib/viewportObserver";
import { useGranted } from "@/lib/useGranted";
import { requestPlaybackStart, requestPreloadMount, retainPausedVideo, retainPlayingVideo } from "@/lib/previewVideoPool";

const PRELOAD_MARGIN_PX = 700;
const VIDEO_RELEASE_MS = 400;

/** Shared by shot and search cards; only the actual viewport consumes playback. */
export function usePreviewActivity({ rootRef, index, play, hovered, url }: {
  rootRef: RefObject<HTMLDivElement | null>;
  index: number;
  play: boolean;
  hovered: boolean;
  url: string | null;
}) {
  const [nearVideo, setNearVideo] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stopNear = observeViewport(el, PRELOAD_MARGIN_PX, setNearVideo);
    const stopVisible = observeViewport(el, 0, setVisible);
    return () => { stopNear(); stopVisible(); };
  }, [rootRef]);

  // Hover does not release an autoplay start and requeue it on pointer leave.
  const started = useGranted(play && visible, (grant) => requestPlaybackStart(index, grant), [index]);
  const wantVideo = visible && (hovered || started);
  const [held, setHeld] = useState(false);
  const [preloadEvicted, setPreloadEvicted] = useState(false);
  if (preloadEvicted && !nearVideo) setPreloadEvicted(false);
  const preloadWanted = nearVideo && play && !preloadEvicted && !!url;
  useEffect(() => {
    if (!preloadWanted || wantVideo || held) return;
    return requestPreloadMount(index, () => setHeld(true));
  }, [preloadWanted, wantVideo, held, index]);
  if (wantVideo && url && !held) setHeld(true);
  if (held && !url) setHeld(false);
  useEffect(() => {
    if (!held || nearVideo) return;
    const timer = setTimeout(() => setHeld(false), VIDEO_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [held, nearVideo]);

  const showVideo = held && !!url;
  const videoPaused = !wantVideo;
  useEffect(() => {
    if (!showVideo) return;
    if (!videoPaused) return retainPlayingVideo();
    return retainPausedVideo(() => { setHeld(false); setPreloadEvicted(true); });
  }, [showVideo, videoPaused]);
  return { nearVideo, visible, wantVideo, showVideo, videoPaused };
}
