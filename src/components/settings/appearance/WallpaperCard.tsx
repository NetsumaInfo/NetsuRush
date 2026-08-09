// Fond d'écran : source, bibliothèque et réglages. Les fichiers importés vivent dans NR_HOME
// (adressés par hash de contenu) — réimporter le même visuel ne duplique rien.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import type { WallpaperEntry } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { themeAllowsWallpaper } from "@/lib/wallpaper";
import { useApp } from "@/store";
import { WallpaperControls } from "./WallpaperControls";
import { WallpaperFramingDialog } from "./WallpaperFramingDialog";

/** Une vignette de bibliothèque : assez large pour reconnaître une image, assez courte pour tenir en bande. */
const THUMB_CLASS = "h-14 w-24 shrink-0 overflow-hidden rounded-md border object-cover transition-colors";

export function WallpaperCard() {
  const { t } = useTranslation("settings");
  const theme = useApp((s) => s.theme);
  const config = useApp((s) => s.wallpaper);
  const setWallpaper = useApp((s) => s.setWallpaper);
  const reset = useApp((s) => s.resetWallpaper);

  const [entries, setEntries] = useState<WallpaperEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [framing, setFraming] = useState(false);

  const refresh = useCallback(async () => {
    const res = await nr.wallpaper?.list();
    setEntries(res?.ok && res.entries ? res.entries : []);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const selected = useMemo(() => entries.find((entry) => entry.id === config.id) ?? null, [entries, config.id]);

  const importFile = useCallback(async (path: string) => {
    setBusy(true);
    setError(null);
    // L'encodage de la variante de base prend quelques secondes sur une longue animation : on montre
    // l'attente plutôt que de laisser croire à un clic sans effet.
    const res = await nr.wallpaper?.import(path, {});
    setBusy(false);
    if (!res?.ok || !res.entry) {
      setError(res?.error ?? t("appearance.wallpaper.importFailed"));
      return;
    }
    await refresh();
    setWallpaper({ id: res.entry.id });
  }, [refresh, setWallpaper, t]);

  const pick = useCallback(async () => {
    const path = await nr.chooseAnyFile();
    if (path) await importFile(path);
  }, [importFile]);

  const onDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    setDropping(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    const [path] = await nr.pathsForFiles(files);
    if (path) await importFile(path);
    else setError(t("appearance.wallpaper.importFailed"));
  }, [importFile, t]);

  const remove = useCallback(async (id: string) => {
    await nr.wallpaper?.remove(id);
    if (config.id === id) setWallpaper({ id: null });
    await refresh();
  }, [config.id, refresh, setWallpaper]);

  if (!themeAllowsWallpaper(theme)) {
    return (
      <section className="flex flex-col gap-1 border-t border-border pt-5">
        <h3 className="text-sm font-medium">{t("appearance.wallpaper.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("appearance.wallpaper.blockedByTheme")}</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium">{t("appearance.wallpaper.title")}</h3>
        {/* Le fond ne suit PLUS le thème : le dire ici évite de chercher pourquoi il ne change pas. */}
        <p className="text-xs text-muted-foreground">{t("appearance.wallpaper.global")}</p>
      </div>

      {/* Bande de bibliothèque : les vignettes SONT le choix, et la tuile d'ajout vit dans la même
          rangée. Un grand cadre en pointillés pour une seule image donnait un vide disproportionné. */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => void onDrop(e)}
        className={cn(
          "flex items-center gap-2 overflow-x-auto rounded-lg p-1 transition-colors",
          dropping ? "bg-accent" : "bg-transparent",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => void pick()}
                disabled={busy}
                className={cn(
                  THUMB_CLASS,
                  "grid place-items-center border-dashed border-border text-muted-foreground",
                  "hover:border-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-60",
                )}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              </button>
            }
          />
          <TooltipContent>{t("appearance.wallpaper.choose")}</TooltipContent>
        </Tooltip>

        {config.id ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => setWallpaper({ id: null })}
                  className={cn(
                    THUMB_CLASS,
                    "grid place-items-center border-border bg-card text-muted-foreground",
                    "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  )}
                >
                  <X className="size-4" />
                </button>
              }
            />
            <TooltipContent>{t("appearance.wallpaper.none")}</TooltipContent>
          </Tooltip>
        ) : null}

        {entries.map((entry) => (
          <div key={entry.id} className="group relative shrink-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={entry.id === config.id}
                    onClick={() => setWallpaper({ id: entry.id })}
                    className={cn(
                      THUMB_CLASS,
                      "block focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      entry.id === config.id ? "border-primary ring-1 ring-primary" : "border-border hover:border-muted-foreground",
                    )}
                  >
                    <img src={nr.mediaUrl(entry.poster)} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  </button>
                }
              />
              <TooltipContent>{entry.name}</TooltipContent>
            </Tooltip>
            <button
              type="button"
              aria-label={t("appearance.wallpaper.remove")}
              onClick={() => void remove(entry.id)}
              className="absolute top-1 right-1 rounded bg-black/70 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        ))}

        {!entries.length ? (
          <p className="px-2 text-xs text-muted-foreground">{t("appearance.wallpaper.empty")}</p>
        ) : null}
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {config.id ? (
        <>
          <WallpaperControls
            config={config}
            animated={selected?.kind === "animated"}
            onChange={setWallpaper}
            onOpenFraming={() => setFraming(true)}
          />
          {selected ? (
            <WallpaperFramingDialog
              open={framing}
              onOpenChange={setFraming}
              config={config}
              // Variante de base : la boucle mp4 si le fond est animé, sinon son image. On cadre ce
              // qu'on aura, pas une première frame arrêtée.
              media={{
                path: selected.base,
                animated: selected.kind === "animated",
                width: selected.width,
                height: selected.height,
              }}
              onChange={setWallpaper}
            />
          ) : null}
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={reset}>
              <RotateCcw className="size-3.5" /> {t("appearance.wallpaper.reset")}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
