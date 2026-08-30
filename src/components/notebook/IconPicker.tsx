// Sélecteur d'icône — 3 onglets : Emojis (EmojiPicker maison, thémé sur les tokens de
// l'app), Icônes (grille lucide-react cherchable), Upload (image locale → /media). Renvoie une chaîne
// d'icône : emoji natif "🎬"  |  "lucide:Rocket"  |  URL http (image uploadée).  Rendu par renderPageIcon.
import { createElement, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Smile, Shapes, Upload, Search, Trash2 } from "lucide-react";
import { lucideIcon, lucideNames, useLucideCatalog } from "@/lib/lucideCatalog";
import { LucideGlyph } from "@/components/common/LucideGlyph";
import { HoverLabel } from "@/components/common/HoverLabel";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import i18n from "@/i18n";

type Tab = "emoji" | "icon" | "upload";

// Rendu d'une icône de page (emoji / lucide / image) — partagé par PageHeader & co.
export function renderPageIcon(icon: string | null, cls = "h-7 w-7", emojiCls = "text-[2rem]"): React.ReactNode {
  if (!icon) return <Smile className={`${cls} text-muted-foreground`} />;
  if (icon.startsWith("lucide:")) return <LucideGlyph name={icon.slice(7)} fallback={Smile} className={cls} />;
  if (/^(https?:|blob:|data:)/.test(icon)) return <img src={icon} alt="" className={`${cls} rounded object-cover`} draggable={false} />;
  return <span className={`${emojiCls} leading-none`}>{icon}</span>;
}

function EmojiTab({ onPick }: { onPick: (v: string) => void }) {
  return <EmojiPicker onPick={onPick} heightClass="max-h-80" />;
}

function IconTab({ onPick }: { onPick: (v: string) => void }) {
  // Grille du jeu COMPLET : le catalogue arrive dans un chunk asynchrone (cf. lib/lucideCatalog).
  useLucideCatalog();
  const names = lucideNames();
  const [q, setQ] = useState("");
  // Une seule bulle pour toute la grille (cf. common/HoverLabel) : un Tooltip par cellule coûtait
  // 300 stores de positionnement et saccadait le survol.
  const gridRef = useRef<HTMLDivElement>(null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? names.filter((n) => n.toLowerCase().includes(s)) : names).slice(0, 300);
  }, [q, names]);
  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-muted px-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={i18n.t("notebook:icons.search")} className="w-full bg-transparent py-1.5 text-sm outline-none" />
      </div>
      <div ref={gridRef} className="grid max-h-72 grid-cols-8 gap-1 overflow-y-auto">
        {list.map((n) => (
          <button key={n} type="button" aria-label={n} data-hover-label={n} onClick={() => onPick(`lucide:${n}`)}
            className="flex aspect-square items-center justify-center rounded-md text-foreground hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-primary">
            {createElement(lucideIcon(n) as LucideIcon, { className: "h-4 w-4" })}
          </button>
        ))}
      </div>
      <HoverLabel containerRef={gridRef} />
    </div>
  );
}

function UploadTab({ onPick }: { onPick: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const send = async (file?: File) => {
    if (!file || !nr.notebook) return;
    setBusy(true);
    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const r = await nr.notebook.saveAsset(await file.arrayBuffer(), ext, useApp.getState().nbActiveId ?? undefined);
      if (r.ok && r.url) onPick(r.url);
    } finally { setBusy(false); }
  };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void send(Array.from(e.dataTransfer.files)[0]); }}
      className={`flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm ${over ? "border-primary bg-primary/5" : "border-border"}`}
    >
      <Upload className="h-6 w-6 text-muted-foreground" />
      <button type="button" onClick={() => input.current?.click()} className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-60" disabled={busy}>
        {busy ? i18n.t("notebook:icons.uploading") : i18n.t("notebook:icons.chooseImage")}
      </button>
      <span className="text-xs text-muted-foreground">{i18n.t("notebook:icons.dropFile")}</span>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => void send(e.target.files?.[0] || undefined)} />
    </div>
  );
}

export function IconPicker({ current, onPick, onRemove }: { current: string | null; onPick: (v: string) => void; onRemove: () => void }) {
  const [tab, setTab] = useState<Tab>("emoji");
  const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
    { id: "emoji", label: i18n.t("notebook:icons.emojis"), icon: Smile },
    { id: "icon", label: i18n.t("notebook:icons.icons"), icon: Shapes },
    { id: "upload", label: i18n.t("notebook:icons.upload"), icon: Upload },
  ];
  return (
    <div className="w-[22rem]">
      <div className="mb-2 flex items-center gap-1 border-b border-border pb-2">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`flex items-center gap-1 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary ${tab === t.id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {createElement(t.icon, { className: "h-3.5 w-3.5" })} {t.label}
          </button>
        ))}
        {current && (
          <button type="button" onClick={onRemove} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" /> {i18n.t("common:action.remove")}
          </button>
        )}
      </div>
      {tab === "emoji" && <EmojiTab onPick={onPick} />}
      {tab === "icon" && <IconTab onPick={onPick} />}
      {tab === "upload" && <UploadTab onPick={onPick} />}
    </div>
  );
}
