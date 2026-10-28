import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useShallow } from "zustand/react/shallow";
import { nr, type SearchHit } from "@/lib/bridge";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SelectCheck } from "@/components/common/selectable";
import { PreviewVideo } from "@/components/player/PreviewVideo";
import { basename, useShotBrowser } from "./useShotBrowser";

// Clé d'identité stable d'une référence (chemin direct ou plan d'un rush).
const refKey = (r: { path?: string; file_path?: string; scene_index?: number }) =>
  r.path ? `p:${r.path}` : `s:${r.file_path}#${r.scene_index}`;

// Cellule d'un plan : vignette + aperçu vidéo (proxy) au survol + (dé)sélection au clic.
function ShotCell({ shot, thumb, active, onToggle }: {
  shot: SearchHit; thumb?: string; active: boolean; onToggle: () => void;
}) {
  const { t } = useTranslation("search");
  const [hover, setHover] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const asked = useRef(false);

  async function onEnter() {
    setHover(true);
    if (src || asked.current) return;
    asked.current = true;
    try {
      const r = await nr.proxy({ input: shot.file_path, start: shot.start_sec, end: shot.end_sec, priority: "high" });
      if (r.ok && r.path) setSrc(nr.mediaUrl(r.path));
    } catch { /* aperçu non critique */ }
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost"
        type="button"
        onClick={onToggle}
        onMouseEnter={onEnter}
        onMouseLeave={() => setHover(false)}
        className={cn("h-auto justify-start whitespace-normal text-left font-normal border-0 p-0 gap-0 rounded-none hover:bg-transparent dark:hover:bg-transparent", 
          "group relative aspect-video overflow-hidden rounded-lg border bg-muted transition-colors",
          active ? "border-primary ring-2 ring-primary" : "border-border hover:border-foreground/40",
        )}
      >
      {thumb ? (
        <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground"><NetsuIcon name="film" className="size-5 opacity-40" /></div>
      )}
      {hover && src && (
        <PreviewVideo url={src} label={t("referencePicker.previewAria")} onError={() => setSrc(null)} />
      )}
      {hover && !src && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30"><NetsuIcon name="play" className="size-5 text-white/80" /></div>
      )}
      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">#{shot.scene_index + 1}</span>
      {active && <SelectCheck />}
      </Button>} />
      <TooltipContent>{active ? t("referencePicker.removeFromRefs") : t("referencePicker.addAsRef")}</TooltipContent>
    </Tooltip>
  );
}

// Picker pour choisir une image de référence DEPUIS les rush déjà indexés :
// onglet Médias (liste des clips, filtrable par nom) → Découpes (grille des plans) → clic = ajoute la réf.
// Les vignettes sont chargées par lot (cmd_shot_thumbs) — un long rush = 1000+ plans, jamais d'un bloc.
export function ReferencePicker({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("search");
  const { addRef, removeRef, refs } = useApp(
    useShallow((s) => ({ addRef: s.addRef, removeRef: s.removeRef, refs: s.refs })),
  );
  const {
    query, setQuery,
    clip, shots, thumbs, shown, error, loading,
    indexedPaths, clips,
    scrollRef, sentinelRef,
    openClip, closeClip,
  } = useShotBrowser();

  const refKeys = new Set(refs.map(refKey));

  function toggleRef(s: SearchHit) {
    const key = `s:${s.file_path}#${s.scene_index}`;
    const idx = refs.findIndex((r) => refKey(r) === key);
    if (idx >= 0) removeRef(idx);
    else addRef({ file_path: s.file_path, scene_index: s.scene_index, thumb: thumbs[s.scene_index] });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[80vh] w-[900px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]"
      >
        <DialogTitle className="sr-only">{t("referencePicker.title")}</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          {clip ? (
            <Button variant="ghost" size="sm" onClick={closeClip}>
              <NetsuIcon name="back" className="size-4" /> {t("referencePicker.media")}
            </Button>
          ) : (
            <span className="inline-flex items-center gap-2 text-sm font-medium">
              <NetsuIcon name="gallery" className="size-4 text-primary" /> {t("referencePicker.title")}
            </span>
          )}
          <div className="flex-1" />
          {clip && (
            <Tooltip>
              <TooltipTrigger render={<span className="truncate text-xs text-muted-foreground">{basename(clip)} · {t("referencePicker.cuts")}{shots ? ` (${shots.length})` : ""}</span>} />
              <TooltipContent>{clip}</TooltipContent>
            </Tooltip>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}><NetsuIcon name="close" className="size-4" /></Button>
        </div>

        {error && !clip && <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">{error}</div>}

        {/* vue Médias : barre de nom + liste des clips indexés */}
        {!clip ? (
          <>
            <div className="border-b border-border px-4 py-2">
              <InputGroup>
                <InputGroupAddon><NetsuIcon name="search" /></InputGroupAddon>
                <InputGroupInput
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("referencePicker.searchPlaceholder")}
                />
                {query && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="icon-xs" aria-label={t("referencePicker.clearAria")} onClick={() => setQuery("")}><NetsuIcon name="close" /></InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {loading ? (
                <div className="flex h-full items-center justify-center text-muted-foreground"><Spinner /></div>
              ) : clips.length === 0 ? (
                <div className="p-8 text-center text-xs text-muted-foreground">
                  {indexedPaths.length === 0 ? t("referencePicker.noIndexedRushes") : t("referencePicker.noRushMatch", { query })}
                </div>
              ) : (
                <div className="flex flex-col">
                  {clips.map((c) => (
                    <Tooltip key={c.path}>
                      <TooltipTrigger render={<Button variant="ghost"
                        type="button"
                        onClick={() => openClip(c.path)}
                        className="h-auto justify-start whitespace-normal text-left font-normal border-0 p-0 gap-0 rounded-none hover:bg-transparent dark:hover:bg-transparent flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
                      >
                      <NetsuIcon name="film" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{c.name}</span>
                      </Button>} />
                      <TooltipContent>{c.path}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          /* vue Découpes : grille des plans du clip → clic = ajoute la réf */
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-3">
            {shots === null ? (
              <div className="flex h-full items-center justify-center text-muted-foreground"><Spinner className="size-5" /></div>
            ) : error ? (
              <div className="p-8 text-center text-xs text-red-300">{error}</div>
            ) : shots.length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground">{t("referencePicker.noShots")}</div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                  {shots.slice(0, shown).map((s) => (
                    <ShotCell
                      key={s.scene_index}
                      shot={s}
                      thumb={thumbs[s.scene_index]}
                      active={refKeys.has(`s:${s.file_path}#${s.scene_index}`)}
                      onToggle={() => toggleRef(s)}
                    />
                  ))}
                </div>
                {shown < shots.length && (
                  <div ref={sentinelRef} className="mt-3 flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
                    <Spinner className="size-3.5" /> {t("referencePicker.loadingMore", { count: shots.length - shown })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{t("referencePicker.selectedCount", { count: refs.length })}</span>
          <Button size="sm" onClick={onClose}>{t("referencePicker.done")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
