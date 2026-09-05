import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FlowState } from "@/lib/bridge";

/// A dark backdrop hides exactly what a compositing preview must show: a black
/// overlay at low alpha. The choice is the user's, because an overlay reads on
/// one background and a bright graphic on another.
const BACKDROPS = [
  { id: "checker", labelKey: "bgChecker" },
  { id: "dark", labelKey: "bgDark" },
  { id: "mid", labelKey: "bgMid" },
  { id: "light", labelKey: "bgLight" },
] as const;

type Backdrop = (typeof BACKDROPS)[number]["id"];

const BACKDROP_STYLE: Record<Backdrop, string> = {
  checker: "repeating-conic-gradient(#d8d8de 0 25%, #f2f2f6 0 50%) 0 0 / 24px 24px",
  dark: "#0b0b0f",
  mid: "#808080",
  light: "#ffffff",
};

/// Scrubbing settles before it renders: a fresh frame costs ~300 ms, so asking
/// for every intermediate position queues work the user has already passed.
const SCRUB_SETTLE_MS = 120;

type Mode = "live" | "render";

export function FlowPreview({ state, frame, onFrame, frameUrl, revision, editorPort, note }: {
  state: FlowState;
  frame: number;
  onFrame: (frame: number) => void;
  frameUrl: (frame: number) => string;
  revision: number;
  editorPort: number;
  note: (text: string) => void;
}) {
  const { t } = useTranslation("flow");
  const [backdrop, setBackdrop] = useState<Backdrop>("checker");
  const [mode, setMode] = useState<Mode>("live");
  const [playing, setPlaying] = useState(false);
  const live = useRef<HTMLIFrameElement | null>(null);
  const picture = useRef<HTMLImageElement | null>(null);

  const lastFrame = Math.max(0, (state.durationFrames || 1) - 1);
  const fps = state.fps || 24;

  // Read by the playback interval and by the message handler, so neither has
  // to be rebuilt when the playhead moves. Rebuilding the interval on every
  // frame was why rendered playback stuttered.
  const live$ = useRef({ frame, mode, playing, lastFrame, fps });
  live$.current = { frame, mode, playing, lastFrame, fps };

  const toLive = useCallback((message: Record<string, unknown>) => {
    live.current?.contentWindow?.postMessage(message, "*");
  }, []);

  /// One <img>, its source swapped rather than the element replaced: a `key`
  /// that changes remounts the image and flashes the backdrop between frames.
  const showFrame = useCallback(async (index: number) => {
    const response = await fetch(frameUrl(index));
    if (!response.ok) {
      note(`${response.status} ${response.statusText}`);
      return;
    }
    const opaque = response.headers.get("x-opaque-pixels");
    if (opaque !== null) {
      const total = state.width * state.height;
      // Said outright: a transparent composition on the wrong backdrop looks
      // exactly like a composition that failed to render.
      note(Number(opaque) === 0
        ? t("transparent")
        : `${Math.round((Number(opaque) / total) * 100)} % ${t("opaque")}`);
    }
    const blob = await response.blob();
    const element = picture.current;
    if (!element) return;
    const previous = element.src;
    element.src = URL.createObjectURL(blob);
    if (previous.startsWith("blob:")) URL.revokeObjectURL(previous);
  }, [frameUrl, note, state.width, state.height, t]);

  // The live document is built with the current variables at request time, so
  // a change only reaches it by reloading it. This is the editor's own
  // `reloadLive()`, and skipping it is why Live showed a stale composition.
  useEffect(() => {
    const element = live.current;
    if (!element || !editorPort) return;
    element.src = `http://127.0.0.1:${editorPort}/live?r=${revision}`;
  }, [editorPort, revision]);

  // The live document announces itself when its clock is ready. Sending play
  // or seek before that arrives is sending into a document that does not exist
  // yet, and the message is simply lost — which is why play did nothing.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; t?: number; duration?: number } | null;
      if (!message) return;
      if (message.type === "hf-ready") {
        const now = live$.current;
        toLive({ type: "hf-seek", t: now.frame / now.fps });
        toLive({ type: now.playing && now.mode === "live" ? "hf-play" : "hf-pause" });
        return;
      }
      if (message.type === "hf-error") {
        note(String((message as { message?: string }).message ?? ""));
        return;
      }
      if (message.type !== "hf-time") return;
      // Only the live clock may move the playhead, and only while it is the
      // one on screen and actually running.
      const now = live$.current;
      if (now.mode !== "live" || !now.playing) return;
      onFrame(Math.min(now.lastFrame, Math.round((message.t ?? 0) * now.fps)));
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [toLive, onFrame, note]);

  /// Seeking is something the USER does. It is not an echo of where the live
  /// clock says it already is.
  ///
  /// Seeking from an effect on the playhead value looked equivalent and was
  /// not: the playhead also changes because `hf-time` just reported it, so
  /// every tick sent the live document back to the rounded frame it had just
  /// moved past. Sixty times a second, the clock was yanked to a frame
  /// boundary — which is what the scrubber was doing when it trembled.
  const seekLive = useCallback((to: number) => {
    toLive({ type: "hf-seek", t: to / live$.current.fps });
  }, [toLive]);

  // One playhead for both modes. Separate ones are what made switching look
  // like it jumped or started playing on its own: two clocks, not one player.
  useEffect(() => {
    seekLive(live$.current.frame);
    toLive({ type: playing && mode === "live" ? "hf-play" : "hf-pause" });
  }, [playing, mode, toLive, seekLive]);

  // Rendered playback steps at the composition's rate and falls behind while
  // frames are still being made, rather than queueing them. Live has no such
  // ceiling, which is the whole reason both exist.
  useEffect(() => {
    if (!playing || mode !== "render") return;
    let rendering = false;
    const timer = setInterval(async () => {
      const now = live$.current;
      if (rendering || now.mode !== "render" || !now.playing) return;
      rendering = true;
      const next = now.frame >= now.lastFrame ? 0 : now.frame + 1;
      onFrame(next);
      await showFrame(next).catch(() => undefined);
      rendering = false;
    }, 1000 / fps);
    return () => clearInterval(timer);
  }, [playing, mode, fps, onFrame, showFrame]);

  // Scrubbing and edits repaint the still, but only where the playhead landed.
  useEffect(() => {
    if (mode !== "render" || playing) return;
    const timer = setTimeout(() => { void showFrame(frame); }, SCRUB_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [mode, playing, frame, revision, showFrame]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-3 py-1.5">
        {(["live", "render"] as const).map((entry) => (
          <Tooltip key={entry}>
            <TooltipTrigger render={
              <Button
                variant={mode === entry ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setMode(entry)}
              >
                {t(entry === "live" ? "modeLive" : "modeRender")}
              </Button>
            } />
            <TooltipContent>
              {t(entry === "live" ? "modeLiveHint" : "modeRenderHint")}
            </TooltipContent>
          </Tooltip>
        ))}
        <span className="ml-2 text-xs tabular-nums text-muted-foreground">
          {state.width} × {state.height} · {state.fps} fps · {state.durationFrames} {t("frames")}
        </span>
        <span className="flex-1" />
        {BACKDROPS.map((entry) => (
          <Button
            key={entry.id}
            variant={backdrop === entry.id ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setBackdrop(entry.id)}
          >
            {t(entry.labelKey)}
          </Button>
        ))}
      </div>

      <div
        className="grid min-h-0 flex-1 place-items-center overflow-hidden p-4"
        style={{ background: BACKDROP_STYLE[backdrop] }}
      >
        {/* Both stay mounted. Unmounting the iframe on a mode switch would
            restart the composition and lose the clock it just published. */}
        <iframe
          ref={live}
          title="live"
          className={mode === "live"
            ? "h-full w-full border-0 bg-transparent"
            : "pointer-events-none absolute size-0 opacity-0"}
        />
        <img
          ref={picture}
          alt=""
          className={mode === "render"
            ? "max-h-full max-w-full object-contain shadow-lg"
            : "hidden"}
        />
      </div>

      <div className="flex items-center gap-3 border-t px-3 py-2">
        <Button
          size="icon"
          variant="secondary"
          className="size-8"
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Input
          type="range"
          className="h-8 flex-1 p-0"
          min={0}
          max={lastFrame}
          step={1}
          value={frame}
          onChange={(event) => {
            // Scrubbing pauses, in both modes: a playhead that fights the user
            // is what made this feel unpredictable.
            if (playing) setPlaying(false);
            const to = Number(event.target.value);
            onFrame(to);
            seekLive(to);
          }}
        />
        <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
          {frame} / {lastFrame}
        </span>
      </div>
    </div>
  );
}
