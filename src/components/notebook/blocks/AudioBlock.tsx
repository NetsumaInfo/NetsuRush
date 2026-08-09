// Bloc « Audio » custom — REMPLACE le bloc audio par défaut de BlockNote (natif `<audio controls>`,
// moche + hors thème) par un lecteur maison harmonisé : forme d'onde stylisée (barres déterministes
// depuis l'URL, portion lue teintée), lecture/scrub, temps, volume, vitesse (1×/1,5×/2×). Événements
// média (timeupdate/loadedmetadata), zéro boucle rAF (interdit perf). propSchema = bloc audio défaut →
// upload/drag-drop/collage d'URL rendent ce lecteur.
import { useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import i18n from "@/i18n";
import { createReactBlockSpec } from "@blocknote/react";
import { defaultProps, type BlockNoteEditor } from "@blocknote/core";
import { Music, Play, Pause, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { VolumeSlider } from "@/components/player/VolumeSlider";

type Ed = BlockNoteEditor<any, any, any>;

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Forme d'onde DÉTERMINISTE (pas de décodage Web Audio → zéro coût) : hauteurs pseudo-aléatoires
// dérivées d'un hash de l'URL, stables entre les rendus. Donne l'aspect « waveform » sans les peaks réels.
function waveform(url: string, n = 56): number[] {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  const bars: number[] = [];
  for (let i = 0; i < n; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const base = (h % 1000) / 1000;                       // 0..1
    const env = 0.35 + 0.65 * Math.sin((i / n) * Math.PI); // enveloppe douce (plus bas aux extrémités)
    bars.push(Math.max(0.12, base * env));
  }
  return bars;
}

const SPEEDS = [1, 1.5, 2] as const;

function AudioPlayer({ url, name }: { url: string; name?: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);
  const [vol, setVol] = useState(1);          // volume 0..1
  const [speed, setSpeed] = useState(1);
  const bars = useMemo(() => waveform(url), [url]);

  const toggle = () => { const a = audio.current; if (!a) return; if (a.paused) void a.play(); else a.pause(); };
  const seekTo = (clientX: number, el: HTMLElement) => {
    const a = audio.current; if (!a || !dur) return;
    const r = el.getBoundingClientRect();
    a.currentTime = Math.min(dur, Math.max(0, ((clientX - r.left) / r.width) * dur));
  };
  const onBarPointer = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1 && e.type === "pointermove") return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekTo(e.clientX, e.currentTarget);
  };
  const toggleMute = () => { const a = audio.current; if (!a) return; a.muted = !a.muted; setMuted(a.muted); };
  // Règle le volume (et dé-mute si on remonte le son depuis 0/muet).
  const setVolume = (v: number) => {
    const nv = Math.min(1, Math.max(0, v));
    const a = audio.current;
    if (a) { a.volume = nv; a.muted = nv === 0; }
    setVol(nv);
    setMuted(nv === 0);
  };
  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed as 1) + 1) % SPEEDS.length];
    if (audio.current) audio.current.playbackRate = next;
    setSpeed(next);
  };

  const progress = dur ? cur / dur : 0;
  const label = name || url.split(/[\\/]/).pop() || i18n.t("notebook:numberLabels.audio");

  return (
    <div contentEditable={false} className="my-1.5 flex items-center gap-3 rounded-xl border border-border bg-card/50 px-3 py-2.5">
      <audio
        ref={audio}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onEnded={() => setPlaying(false)}
      />
      <button
        type="button"
        onClick={toggle}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105"
        aria-label={playing ? i18n.t("common:player.pause") : i18n.t("common:player.play")}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <Music className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-foreground">{label}</span>
        </div>
        {/* Forme d'onde cliquable/scrubable : barres, portion lue teintée en primary */}
        <div
          onPointerDown={onBarPointer}
          onPointerMove={onBarPointer}
          className="flex h-8 cursor-pointer items-end gap-px"
        >
          {bars.map((v, i) => {
            const played = i / bars.length <= progress;
            return (
              <span
                key={i}
                className="min-w-0 flex-1 rounded-sm"
                style={{ height: `${Math.round(v * 100)}%`, background: played ? "var(--color-primary)" : "color-mix(in srgb, var(--color-fg) 22%, transparent)" }}
              />
            );
          })}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-xs tabular-nums text-muted-foreground">{fmt(cur)} / {fmt(dur)}</span>
        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={cycleSpeed} className="flex w-14 shrink-0 items-center justify-center gap-1 rounded px-1 py-0.5 text-[11px] whitespace-nowrap tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground"><Gauge className="h-3 w-3 shrink-0" />{speed}×</button>} />
            <TooltipContent>{i18n.t("notebook:blocksUi.playbackSpeed")}</TooltipContent>
          </Tooltip>
          {/* Volume ANCRÉ dans la barre (toujours visible, pas de popup) : même curseur que les lecteurs. */}
          <div className="w-24 text-muted-foreground">
            <VolumeSlider
              value={muted ? 0 : vol}
              onChange={setVolume}
              onToggleMute={toggleMute}
              label={i18n.t("notebook:finalPass.volume")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function AudioEmpty({ editor, block }: { editor: Ed; block: unknown }) {
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const set = (u: string, name = "") => editor.updateBlock(block as never, { type: "audio", props: { url: u, name } });
  const pick = async (file?: File) => {
    if (!file) return;
    const u = await editor.uploadFile?.(file);
    if (typeof u === "string") set(u, file.name);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("audio/"));
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
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-primary shadow-sm"><Music className="h-4 w-4" /></span>
        <Button size="sm" onClick={() => input.current?.click()}>{i18n.t("notebook:blocksUi.chooseAudio")}</Button>
        <span className="text-xs text-muted-foreground">{i18n.t("notebook:blocksUi.audioDrop")}</span>
        <input ref={input} type="file" accept="audio/*" hidden onChange={(e) => void pick(e.target.files?.[0] || undefined)} />
      </div>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter" && /^https?:\/\//i.test(url.trim())) { e.preventDefault(); set(url.trim()); } }}
        placeholder={i18n.t("notebook:blocksUi.audioUrl")}
        className="rounded border border-border bg-muted px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// Override du bloc « audio » par défaut (même clé + propSchema) → tous les chemins d'insertion rendent
// notre lecteur harmonisé.
export const audioSpec = createReactBlockSpec(
  {
    type: "audio",
    propSchema: {
      backgroundColor: defaultProps.backgroundColor,
      name: { default: "" },
      url: { default: "" },
      caption: { default: "" },
      showPreview: { default: true },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => {
      const url = String(block.props.url || "");
      if (!url) return <AudioEmpty editor={editor} block={block} />;
      return <AudioPlayer url={url} name={String(block.props.name || "")} />;
    },
  },
)();
