// Bloc « Vidéo » custom — REMPLACE le bloc vidéo par défaut de BlockNote (moche) par un lecteur maison
// thémé sur la palette : barre de contrôle propre (lecture, scrub, temps, son, plein écran), coins
// arrondis, MUET par défaut (le son ne démarre jamais tout seul). État vide = fichier disque + URL.
// propSchema IDENTIQUE au bloc vidéo par défaut → l'upload/drag-drop de BlockNote continue de marcher.
import { useRef, useState, type DragEvent } from "react";
import i18n from "@/i18n";
import { createReactBlockSpec } from "@blocknote/react";
import { defaultProps, type BlockNoteEditor } from "@blocknote/core";
import { Video as VideoIcon, Play, Pause, Volume2, VolumeX, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizableMediaFrame } from "./ResizableMediaFrame";

type Ed = BlockNoteEditor<any, any, any>;

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Lecteur : contrôles pilotés par événements média (timeupdate/loadedmetadata) — pas de boucle rAF
// (respecte l'interdit perf). Muet par défaut ; l'utilisateur active le son via le bouton.
export function VideoPlayer({ url, caption, width, trimStart = 0, trimEnd = 0, onResize, onTrim }: { url: string; caption?: string; width?: number; trimStart?: number; trimEnd?: number; onResize?: (width: number) => void; onTrim?: (trim: { trimStart: number; trimEnd: number }) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const inPoint = Math.max(0, Math.min(trimStart, dur || trimStart));
  const outPoint = dur > 0 ? Math.min(dur, trimEnd > inPoint ? trimEnd : dur) : trimEnd;

  const toggle = () => {
    const v = vid.current; if (!v) return;
    if (v.paused) { void v.play(); } else v.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = vid.current; if (!v || !dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    v.currentTime = inPoint + ratio * Math.max(0, outPoint - inPoint);
  };
  const toggleMute = () => { const v = vid.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); };
  const full = () => { void wrap.current?.requestFullscreen?.(); };

  const pct = dur ? (cur / dur) * 100 : 0;
  return (
    <ResizableMediaFrame width={width} onResize={(w) => onResize?.(w)} className="my-1">
      <div ref={wrap} className="nb-video group relative h-full overflow-hidden rounded-xl border border-border bg-black">
      <video
        ref={vid}
        src={url}
        muted={muted}
        playsInline
        preload="metadata"
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          if (outPoint > inPoint && v.currentTime >= outPoint) {
            v.pause();
            v.currentTime = inPoint;
          }
          setCur(v.currentTime);
        }}
        onLoadedMetadata={(e) => {
          const duration = e.currentTarget.duration;
          setDur(duration);
          if (trimStart > 0) e.currentTarget.currentTime = Math.min(trimStart, duration);
        }}
        className="block max-h-[520px] w-full cursor-pointer bg-black object-contain"
      />
      {/* Gros bouton lecture au repos */}
      {!playing && (
        <button type="button" onClick={toggle} className="absolute inset-0 flex items-center justify-center" aria-label={i18n.t("notebook:blocksUi.play")}>
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition-transform group-hover:scale-105">
            <Play className="ml-0.5 h-6 w-6" />
          </span>
        </button>
      )}
      {/* Barre de contrôle */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6 opacity-0 transition-opacity group-hover:opacity-100">
        <div role="slider" tabIndex={0} aria-label={i18n.t("common:player.seek")} aria-valuemin={0} aria-valuemax={dur || 0} aria-valuenow={cur} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.preventDefault(); }} onClick={seek} className="pointer-events-auto h-1.5 cursor-pointer rounded-full bg-white/25">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
        <div className="pointer-events-auto flex items-center gap-2 text-white">
          <button type="button" onClick={toggle} className="hover:text-primary" aria-label={playing ? i18n.t("common:player.pause") : i18n.t("common:player.play")}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button type="button" onClick={toggleMute} className="hover:text-primary" aria-label={muted ? i18n.t("common:player.soundOn") : i18n.t("common:player.soundOff")}>
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <span className="text-xs tabular-nums text-white/85">{fmt(cur)} / {fmt(outPoint || dur)}</span>
          <button type="button" onClick={full} className="ml-auto hover:text-primary" aria-label={i18n.t("notebook:blocksUi.fullscreen")}><Maximize2 className="h-4 w-4" /></button>
        </div>
      </div>
      {dur > 0 && onTrim && (
        <div className="flex items-center gap-2 border-t border-white/10 bg-black/80 px-3 py-2 text-[10px] text-white/75">
          <span className="w-6 font-semibold text-primary">IN</span>
          <input
            aria-label="Point d’entrée"
            type="range"
            min={0}
            max={Math.max(0, outPoint - 0.05)}
            step={0.01}
            value={inPoint}
            onChange={(e) => {
              const next = Number(e.target.value);
              onTrim({ trimStart: next, trimEnd: trimEnd > 0 ? Math.max(next + 0.05, trimEnd) : 0 });
              if (vid.current && vid.current.currentTime < next) vid.current.currentTime = next;
            }}
            className="min-w-0 flex-1 accent-primary"
          />
          <span className="w-6 font-semibold text-primary">OUT</span>
          <input
            aria-label="Point de sortie"
            type="range"
            min={Math.min(dur, inPoint + 0.05)}
            max={dur}
            step={0.01}
            value={outPoint || dur}
            onChange={(e) => onTrim({ trimStart: inPoint, trimEnd: Number(e.target.value) })}
            className="min-w-0 flex-1 accent-primary"
          />
        </div>
      )}
      {caption && <div className="bg-black/20 px-3 py-1 text-xs text-white/70">{caption}</div>}
      </div>
    </ResizableMediaFrame>
  );
}

function VideoEmpty({ editor, block }: { editor: Ed; block: unknown }) {
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const set = (u: string, name = "") => editor.updateBlock(block as never, { type: "video", props: { url: u, name } });
  const pick = async (file?: File) => {
    if (!file) return;
    const u = await editor.uploadFile?.(file);
    if (typeof u === "string") set(u, file.name);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("video/"));
    if (f) void pick(f);
  };
  return (
    <div
      contentEditable={false}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`my-1.5 flex flex-col gap-2 rounded-xl border border-dashed px-4 py-5 transition-colors ${over ? "border-primary bg-primary/5" : "border-border bg-muted/30 hover:bg-muted/50"}`}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-primary shadow-sm"><VideoIcon className="h-4 w-4" /></span>
        <Button size="sm" onClick={() => input.current?.click()}>{i18n.t("notebook:blocksUi.chooseVideo")}</Button>
        <span className="text-xs text-muted-foreground">{i18n.t("notebook:blocksUi.dropFile")}</span>
        <input ref={input} type="file" accept="video/*" hidden onChange={(e) => void pick(e.target.files?.[0] || undefined)} />
      </div>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter" && /^https?:\/\//i.test(url.trim())) { e.preventDefault(); set(url.trim()); } }}
        placeholder={i18n.t("notebook:blocksUi.videoUrl")}
        className="rounded border border-border bg-muted px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// Override du bloc « video » par défaut (même clé, même propSchema) → tous les chemins d'insertion
// (slash, upload, drag-drop, collage d'URL) rendent notre lecteur.
export const videoSpec = createReactBlockSpec(
  {
    type: "video",
    propSchema: {
      textAlignment: defaultProps.textAlignment,
      backgroundColor: defaultProps.backgroundColor,
      name: { default: "" },
      url: { default: "" },
      caption: { default: "" },
      width: { default: 0 },
      trimStart: { default: 0 },
      trimEnd: { default: 0 },
      showPreview: { default: true },
      previewWidth: { default: 0 },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const url = String(block.props.url || "");
      if (!url) return <VideoEmpty editor={editor} block={block} />;
      const width = Number(block.props.width) || 0;
      return <VideoPlayer
        url={url}
        width={width}
        caption={String(block.props.caption || "")}
        trimStart={Number(block.props.trimStart) || 0}
        trimEnd={Number(block.props.trimEnd) || 0}
        onResize={(w) => editor.updateBlock(block, { type: "video", props: { width: w } })}
        onTrim={(trim) => editor.updateBlock(block, { type: "video", props: trim } as never)}
      />;
    },
  },
)();
