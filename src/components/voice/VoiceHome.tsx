// Accueil de NetsuTalk : sources (fichiers locaux + Media Pool), préréglage d'analyse, puis la
// liste des rushs RANGÉE PAR DOSSIER. Sélection multiple → analyse en parallèle, puis rendu en
// parallèle avec le profil d'export actif (VoiceBatchBar).
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { FileVideo, FolderOpen, FolderTree, List, RefreshCw, Search } from "lucide-react";
import type { Clip } from "@/lib/bridge";
import { useApp } from "@/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { VOICE_PRESETS, matchVoicePreset } from "./voicePresets";
import { VoiceClipList } from "./VoiceClipList";
import { VoiceBatchBar } from "./VoiceBatchBar";

const GROUP_KEY = "nr.voice.grouped";

// Clip du navigateur → référence attendue par le module voix (le fps arrive en texte côté Resolve).
const toRef = (c: Clip) => ({
  path: c.path, name: c.name,
  source: (c.source === "local" ? "local" : "mediapool") as "local" | "mediapool",
  fps: c.fps ? parseFloat(c.fps) || undefined : undefined,
});

export function VoiceHome({
  clips, loadingClips, connected, clipError, onReload, onPickLocal, onSelect,
}: {
  clips: Clip[];
  loadingClips: boolean;
  connected: boolean;
  clipError: string | null;
  onReload: () => void;
  onPickLocal: () => void;
  onSelect: (c: Clip) => void;
}) {
  const { t } = useTranslation("voice");
  const {
    voiceBatch, voiceBatchRunning, runVoiceBatch, voiceRender, voiceRenderRunning, runVoiceRender,
    silenceParams, hesitationParams, setSilenceParams, setHesitationParams, customPresets,
    voiceError, voiceNotice,
  } = useApp(useShallow((s) => ({
    voiceBatch: s.voiceBatch, voiceBatchRunning: s.voiceBatchRunning, runVoiceBatch: s.runVoiceBatch,
    voiceRender: s.voiceRender, voiceRenderRunning: s.voiceRenderRunning, runVoiceRender: s.runVoiceRender,
    silenceParams: s.silenceParams, hesitationParams: s.hesitationParams,
    setSilenceParams: s.setSilenceParams, setHesitationParams: s.setHesitationParams,
    customPresets: s.customPresets, voiceError: s.voiceError, voiceNotice: s.voiceNotice,
  })));

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [grouped, setGrouped] = useState(() => localStorage.getItem(GROUP_KEY) !== "0");
  const busy = voiceBatchRunning || voiceRenderRunning;

  const activePreset = useMemo(
    () => matchVoicePreset(silenceParams, hesitationParams, customPresets),
    [silenceParams, hesitationParams, customPresets],
  );
  const allPresets = useMemo(() => [...VOICE_PRESETS, ...customPresets], [customPresets]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clips;
    return clips.filter((c) => c.name.toLowerCase().includes(q) || (c.bin || "").toLowerCase().includes(q));
  }, [clips, query]);

  // Rappels STABLES : les rangées sont mémoïsées, une identité qui change à chaque frame de
  // progression annulerait la mémo et re-rendrait toute la liste.
  const toggle = useCallback((paths: string[], value: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    for (const p of paths) { if (value) next.add(p); else next.delete(p); }
    return next;
  }), []);

  const applyPreset = (id: string) => {
    const p = allPresets.find((x) => x.id === id);
    if (!p) return;
    setSilenceParams(p.silence);
    setHesitationParams({ ...p.hesitation });
  };

  const analyzeOne = useCallback((c: Clip) => runVoiceBatch([toRef(c)]), [runVoiceBatch]);
  const renderOne = useCallback((c: Clip) => runVoiceRender([toRef(c)]), [runVoiceRender]);
  const picked = () => visible.filter((c) => selected.has(c.path)).map(toRef);
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.path));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{t("home.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("home.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={onPickLocal}>
            <FileVideo className="size-4" /> {t("home.addFilesShort")}
          </Button>
          <Button size="sm" variant="outline" onClick={onReload} disabled={loadingClips}>
            <FolderOpen className="size-4" /> {t("home.mediaPool")}
          </Button>
        </div>
      </div>

      {/* Préréglage appliqué au lot (mêmes curseurs que l'éditeur — affinables dedans). */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t("home.presetLabel")}</span>
        <ToggleGroup className="flex-wrap" value={activePreset ? [activePreset] : []} onValueChange={(v) => v[0] && applyPreset(v[0])}>
          {allPresets.map((p) => {
            const isBuiltin = "labelKey" in p;
            return (
              <Tooltip key={p.id}>
                <TooltipTrigger render={<ToggleGroupItem className="px-3 text-xs" value={p.id} disabled={busy}>{isBuiltin ? t(p.labelKey) : p.label}</ToggleGroupItem>} />
                <TooltipContent className="max-w-64">{isBuiltin ? t(p.hintKey) : t("home.savedPresetHint")}</TooltipContent>
              </Tooltip>
            );
          })}
        </ToggleGroup>
        {!activePreset && <p className="text-[11px] text-muted-foreground">{t("home.customSettingsHint")}</p>}
      </div>

      <VoiceBatchBar
        selectedCount={selected.size}
        onAnalyze={() => runVoiceBatch(picked())}
        onRender={() => runVoiceRender(picked())}
      />

      {voiceError && <p className="text-xs text-destructive">{voiceError}</p>}
      {voiceNotice && !voiceError && <p className="text-xs text-muted-foreground">{voiceNotice}</p>}
      {!connected && clipError && <p className="text-[11px] text-muted-foreground">{clipError}</p>}

      {/* Barre de liste : filtre, tout sélectionner, arborescence ou liste à plat, rechargement. */}
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            className="h-7 pl-7 text-xs"
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {t("home.countSelected", { selected: selected.size, total: visible.length })}
        </span>
        <Button variant="ghost" size="sm" className="text-xs" disabled={!visible.length}
          onClick={() => toggle(visible.map((c) => c.path), !allVisibleSelected)}>
          {allVisibleSelected ? t("home.selectNone") : t("home.selectAll")}
        </Button>
        <Tooltip>
          <TooltipTrigger render={
            <Button variant="ghost" size="icon-sm" aria-label={grouped ? t("home.flatView") : t("home.folderView")}
              onClick={() => { const v = !grouped; setGrouped(v); localStorage.setItem(GROUP_KEY, v ? "1" : "0"); }} />
          }>
            {grouped ? <FolderTree className="size-4" /> : <List className="size-4" />}
          </TooltipTrigger>
          <TooltipContent>{grouped ? t("home.flatView") : t("home.folderView")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={
            <Button variant="ghost" size="icon-sm" onClick={onReload} disabled={loadingClips} aria-label={t("home.reloadMediaPool")} />
          }>
            <RefreshCw className={cn("size-4", loadingClips && "animate-spin")} />
          </TooltipTrigger>
          <TooltipContent>{t("home.reloadMediaPool")}</TooltipContent>
        </Tooltip>
      </div>

      {loadingClips && !clips.length ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" /> {t("home.loadingSource")}</div>
      ) : !visible.length ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {clips.length ? t("home.noMatch") : t("home.noClips")}
        </p>
      ) : (
        <VoiceClipList
          clips={visible}
          selected={selected}
          batch={voiceBatch}
          render={voiceRender}
          grouped={grouped}
          busy={busy}
          onToggle={toggle}
          onOpen={onSelect}
          onAnalyze={analyzeOne}
          onRender={renderOne}
        />
      )}
    </div>
  );
}
