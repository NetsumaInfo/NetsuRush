import { useEffect, useRef, useState } from "react";
import { Mic, Keyboard, Check, Download, Trash2, Package, AlertTriangle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { modelsForTask, fmtSize, type ModelEntry } from "@/lib/modelRegistry";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useModelManager } from "@/components/settings/models/useModelManager";
import { hotkeyLabel, hotkeyFromEvent, isValidHotkey, isModifierCode, type DictateHotkey } from "@/components/dictate/dictateHotkey";
import { buildMicOptions, micOptionValue, selectedMicLabel } from "@/components/settings/micOptions";

// Capture d'un raccourci : au clic on écoute le prochain keydown. Modificateurs seuls = maintenir la
// combinaison puis relâcher valide ; sinon la 1re touche non-modificateur valide.
function HotkeyCapture({ value, onChange }: { value: DictateHotkey; onChange: (h: DictateHotkey) => void }) {
  const { t } = useTranslation("dictate");
  const [capturing, setCapturing] = useState(false);
  const draft = useRef<DictateHotkey | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === "Escape") { setCapturing(false); draft.current = null; return; }
      const h = hotkeyFromEvent(e);
      draft.current = h;
      // Touche principale non-modificateur → valide immédiatement.
      if (!isModifierCode(e.code) && isValidHotkey(h)) { onChange(h); setCapturing(false); draft.current = null; }
    };
    const onKeyUp = () => {
      // Relâchement d'un combo de modificateurs seuls → valide.
      const h = draft.current;
      if (h && !h.key && isValidHotkey(h)) { onChange(h); setCapturing(false); draft.current = null; }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [capturing, onChange]);

  return (
    <button
      type="button"
      onClick={() => setCapturing((c) => !c)}
      className="inline-flex min-w-40 items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 font-mono text-sm transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-accent"
      aria-pressed={capturing}
    >
      <Keyboard className="size-3.5 text-muted-foreground" />
      {capturing ? t("hotkey.capturePrompt") : hotkeyLabel(value)}
    </button>
  );
}

// Une ligne modèle : radio de sélection + statut (installé / téléchargement / fourni) + action.
function ModelRow({ m, selected, onSelect, mgr }: {
  m: ModelEntry;
  selected: boolean;
  onSelect: () => void;
  mgr: ReturnType<typeof useModelManager>;
}) {
  const { t } = useTranslation(["dictate", "common"]);
  const st = mgr.status[m.id];
  const installed = st?.installed ?? false;
  const dl = mgr.downloading[m.id];
  const busy = dl !== undefined;
  const err = mgr.errors[m.id];
  const size = st?.sizeBytes ?? m.sizeBytes;

  return (
    <label className={cnRow(selected)}>
      <input type="radio" name="dictate-model" checked={selected} onChange={onSelect} className="sr-only" />
      <span className={selected ? "grid size-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground" : "size-4 shrink-0 rounded-full border border-border"}>
        {selected && <Check className="size-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{m.label}</span>
          {m.default && <Badge variant="secondary" className="text-[10px]">{t("model.default")}</Badge>}
          <Badge variant="secondary" className="text-[10px] text-muted-foreground">{m.license}</Badge>
          {!m.commercialUse && <Badge className="border-destructive/40 bg-destructive/10 text-[10px] text-destructive">NC</Badge>}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{m.hint}</p>
        {err && <p className="mt-0.5 flex items-center gap-1 text-xs text-destructive"><AlertTriangle className="size-3" /> {err}</p>}
      </div>
      <span className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {fmtSize(size)}{m.vramGB > 0 && <span className="ml-1 opacity-70">· {m.vramGB} Go</span>}
      </span>
      <span className="w-28 shrink-0 text-right" onClick={(e) => e.preventDefault()}>
        {busy ? (
          <span className="flex items-center justify-end gap-1.5">
            <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">{dl != null ? `${dl}%` : "…"}</span>
            <Progress value={dl} className="h-1 w-10" />
            <Tooltip><TooltipTrigger render={<button type="button" onClick={() => mgr.cancel(m.id)} aria-label={t("common:action.cancel")} className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"><X className="size-3" /></button>} /><TooltipContent>{t("common:action.cancel")}</TooltipContent></Tooltip>
          </span>
        ) : m.bundled ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Package className="size-3.5" /> {t("model.bundled")}</span>
        ) : installed ? (
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex items-center gap-1 text-xs text-[var(--color-ok)]"><Check className="size-3.5" /> {t("model.installed")}</span>
            <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => mgr.remove(m.id)} aria-label={t("common:action.delete")}><Trash2 className="size-3.5" /></Button>} /><TooltipContent>{t("model.removeTooltip")}</TooltipContent></Tooltip>
          </span>
        ) : (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => mgr.download(m.id)}><Download className="size-3.5" /> {t("model.get")}</Button>
        )}
      </span>
    </label>
  );
}

function cnRow(selected: boolean): string {
  return [
    "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1",
    selected ? "border-primary bg-accent" : "border-border hover:bg-accent/50",
  ].join(" ");
}

// Sélecteur de micro : liste les entrées audio. Les libellés ne sont visibles qu'après autorisation
// micro → si absents, on demande la permission une fois puis on relit la liste.
function MicPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { t } = useTranslation("dictate");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        let list = await navigator.mediaDevices.enumerateDevices();
        if (!list.some((d) => d.kind === "audioinput" && d.label)) {
          try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch { /* refusé */ }
          list = await navigator.mediaDevices.enumerateDevices();
        }
        if (alive) setDevices(list.filter((d) => d.kind === "audioinput"));
      } catch { /* noop */ }
    };
    refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => { alive = false; navigator.mediaDevices.removeEventListener?.("devicechange", refresh); };
  }, []);

  // items = map valeur→libellé pour que le déclencheur affiche le NOM du micro (pas le deviceId brut).
  const defaultLabel = t("settings.micDefault");
  const items = buildMicOptions(devices, defaultLabel, (n) => t("settings.micNumbered", { n }));

  return (
    <Select
      items={items}
      value={micOptionValue(value)}
      onValueChange={(v) => {
        const selected = String(v);
        onChange(selected === "default" ? "" : selected.slice("device:".length));
      }}
    >
      <SelectTrigger size="sm" className="w-56">
        <SelectValue>{selectedMicLabel(items, value, defaultLabel)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((it) => <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// Statut du moteur natif transcribe.cpp (requis pour les modèles GGUF type Nemotron). Vert = binaire
// détecté ; ambre = à installer (prébuild GitHub → NR_HOME/bin/transcribe-cli, ou clé transcribeCppBin).
function CppEngineStatus() {
  const { t } = useTranslation("dictate");
  const [st, setSt] = useState<{ ok: boolean; backend: string; error: string | null } | null>(null);
  useEffect(() => { let a = true; nr.dictateCppStatus().then((r) => { if (a) setSt(r); }); return () => { a = false; }; }, []);
  if (!st) return null;
  return (
    <div className={cnRow(false)} style={{ cursor: "default" }}>
      <span className={st.ok ? "size-2 shrink-0 rounded-full bg-[var(--color-ok)]" : "size-2 shrink-0 rounded-full bg-[var(--color-warn)]"} />
      <div className="min-w-0 flex-1">
        <span className="block text-[0.8125rem]">{t("cpp.engine")} {st.ok ? t("cpp.ready", { backend: st.backend }) : t("cpp.notInstalled")}</span>
        <span className="block text-xs text-muted-foreground">
          {st.ok ? t("cpp.readyHint") : t("cpp.notInstalledHint")}
        </span>
      </div>
    </div>
  );
}

const UNLOAD_ITEMS = [
  { value: "30000", labelKey: "unload.s30" },
  { value: "60000", labelKey: "unload.m1" },
  { value: "300000", labelKey: "unload.m5" },
  { value: "900000", labelKey: "unload.m15" },
  { value: "0", labelKey: "unload.never" },
];

export function DictationSettings() {
  const { t } = useTranslation("dictate");
  const enabled = useApp((s) => s.dictateEnabled);
  const setEnabled = useApp((s) => s.setDictateEnabled);
  const hotkey = useApp((s) => s.dictateHotkey);
  const setHotkey = useApp((s) => s.setDictateHotkey);
  const model = useApp((s) => s.dictateModel);
  const setModel = useApp((s) => s.setDictateModel);
  const live = useApp((s) => s.dictateLive);
  const setLive = useApp((s) => s.setDictateLive);
  const mic = useApp((s) => s.dictateMic);
  const setMic = useApp((s) => s.setDictateMic);
  const unloadMs = useApp((s) => s.dictateUnloadMs);
  const setUnloadMs = useApp((s) => s.setDictateUnloadMs);
  const mgr = useModelManager();
  const models = modelsForTask("voice-asr");

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium"><Mic className="size-4" /> {t("settings.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("settings.intro")}</p>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="min-w-0">
          <span className="block text-[0.8125rem]">{t("settings.enableLabel")}</span>
          <span className="block text-xs text-muted-foreground">{t("settings.enableHint")}</span>
        </div>
        <Toggle
          size="sm" variant="outline" pressed={enabled} onPressedChange={setEnabled}
          className="shrink-0 aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary"
        >
          {enabled ? t("settings.enabledOn") : t("settings.enabledOff")}
        </Toggle>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="min-w-0">
          <span className="block text-[0.8125rem]">{t("settings.micLabel")}</span>
          <span className="block text-xs text-muted-foreground">{t("settings.micHint")}</span>
        </div>
        <MicPicker value={mic} onChange={setMic} />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="min-w-0">
          <span className="block text-[0.8125rem]">{t("settings.hotkeyLabel")}</span>
          <span className="block text-xs text-muted-foreground">{t("settings.hotkeyHint")}</span>
        </div>
        <HotkeyCapture value={hotkey} onChange={setHotkey} />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="min-w-0">
          <span className="block text-[0.8125rem]">{t("settings.unloadLabel")}</span>
          <span className="block text-xs text-muted-foreground">{t("settings.unloadHint")}</span>
        </div>
        <Select items={UNLOAD_ITEMS.map((it) => ({ value: it.value, label: t(it.labelKey) }))} value={String(unloadMs)} onValueChange={(v) => setUnloadMs(parseInt(String(v), 10) || 0)}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {UNLOAD_ITEMS.map((it) => <SelectItem key={it.value} value={it.value}>{t(it.labelKey)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="min-w-0">
          <span className="block text-[0.8125rem]">{t("settings.liveLabel")}</span>
          <span className="block text-xs text-muted-foreground">{t("settings.liveHint")}</span>
        </div>
        <Toggle
          size="sm" variant="outline" pressed={live} onPressedChange={setLive}
          className="shrink-0 aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary"
        >
          {live ? t("settings.liveOn") : t("settings.liveOff")}
        </Toggle>
      </div>

      <div>
        <div className="mb-2">
          <span className="text-[0.8125rem]">{t("settings.modelLabel")}</span>
        </div>
        <div className="flex flex-col gap-2">
          {models.map((m) => (
            <ModelRow key={m.id} m={m} selected={m.id === model} onSelect={() => setModel(m.id)} mgr={mgr} />
          ))}
        </div>
        <div className="mt-2"><CppEngineStatus /></div>
      </div>
    </section>
  );
}
