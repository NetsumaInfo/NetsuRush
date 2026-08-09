// En-tête du Chat IA — ALLÉGÉ. Conversations (nouvelle / ouvrir / supprimer) + indicateur d'activité
// + réglages. Le choix du moteur / modèle / permissions vit désormais EN BAS, dans le composer (EngineMenu).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Settings2, Loader2, Plus, MessageSquare, Trash2, ChevronDown } from "lucide-react";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export function ChatHeader({ onSettings }: { onSettings: () => void }) {
  const { t } = useTranslation(["chat", "common"]);
  const running = useApp((s) => s.chatRunning);
  const status = useApp((s) => s.chatStatus);

  const convs = useApp((s) => s.chatConvs);
  const convId = useApp((s) => s.chatConvId);
  const loadConvs = useApp((s) => s.chatLoadConvs);
  const newConv = useApp((s) => s.chatNewConv);
  const openConv = useApp((s) => s.chatOpenConv);
  const delConv = useApp((s) => s.chatDeleteConv);

  useEffect(() => { void loadConvs(); }, [loadConvs]);

  const curTitle = convs.find((c) => c.id === convId)?.title;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="max-w-56 gap-1.5" />}>
          <MessageSquare className="size-3.5 shrink-0" />
          <span className="truncate text-xs">{curTitle || t("header.conversations")}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <button type="button" onClick={newConv} className="mb-1 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <Plus className="size-4" /> {t("header.newConv")}
          </button>
          {convs.length > 0 && <DropdownMenuSeparator />}
          <div className="max-h-72 overflow-y-auto">
            {convs.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("header.noConv")}</div>
            ) : convs.map((c) => (
              <div key={c.id} className={`group flex items-center gap-1 rounded-sm pr-1 ${c.id === convId ? "bg-accent/60" : ""}`}>
                <button type="button" onClick={() => void openConv(c.id)} className="flex-1 truncate px-2 py-1.5 text-left text-sm hover:text-accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  {c.title}
                </button>
                <button type="button" onClick={() => void delConv(c.id)} aria-label={t("common:action.delete")} className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary hover:text-destructive outline-none">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="ghost" size="icon-sm" aria-label={t("header.newConv")} onClick={newConv}><Plus className="size-4" /></Button>

      <div className="ml-auto flex items-center gap-1.5">
        {running && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{status || "…"}</span>}
        <Button size="sm" variant="ghost" onClick={onSettings} aria-label={t("header.settings")}><Settings2 className="size-4" /></Button>
      </div>
    </div>
  );
}
