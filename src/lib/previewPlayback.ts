/** Own a play attempt until the preview pauses, changes source, or unmounts. */
export function startPreviewPlayback(video: HTMLVideoElement): () => void {
  let alive = true;
  let pending = false;
  let mutedRetry = false;
  const start = () => {
    if (!alive || pending || !video.paused) return;
    pending = true;
    void video.play().then(() => { pending = false; }, (error: unknown) => {
      pending = false;
      if (!alive) return;
      const name = (error as { name?: string } | null)?.name;
      if (name === "NotAllowedError" && !mutedRetry) {
        mutedRetry = true;
        video.muted = true;
        start();
      } else if (name !== "AbortError") {
        // Decode/network failures also reach the element's error handler. Do not
        // regenerate a valid proxy just because autoplay with sound was denied.
        console.warn("Preview playback could not start", error);
      }
      // AbortError belongs to an interrupted load/pause. Readiness may retry it;
      // immediately calling play again would resurrect offscreen previews.
    });
  };
  video.addEventListener("canplay", start);
  start();
  return () => {
    alive = false;
    video.removeEventListener("canplay", start);
  };
}
