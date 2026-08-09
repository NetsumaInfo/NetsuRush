import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, FileVideo, Film, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

// Plafonds annoncés par le service (ils dépendent du serveur Discord du webhook, cf. core/bugreport).
// Les tenir ici évite un envoi refusé en 400, où le rapport est perdu sans que le testeur le sache.
const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_MB = 10;

type Props = {
  files: File[];
  onChange: (files: File[]) => void;
  maxFiles?: number;
  maxMB?: number;
};

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} Mo` : `${Math.round(bytes / 1024)} Ko`;
}

function iconFor(file: File) {
  if (file.type.startsWith("video/")) return FileVideo;
  if (file.type.startsWith("audio/")) return Film;
  return FileText;
}

/** Même nom, même taille, même date : c'est un double ajout, pas un second fichier. */
function sameFile(a: File, b: File): boolean {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

// Pièces jointes du rapport : images, vidéos, fichiers. Vignettes, ajout cumulatif, glisser-déposer
// et collage. Le champ `<input file>` nu ne montrait que des noms et REMPLAÇAIT la sélection à chaque
// ouverture — impossible de voir ce qu'on envoie, impossible d'en ajouter une seconde.
export function AttachmentPicker({ files, onChange, maxFiles = DEFAULT_MAX_FILES, maxMB = DEFAULT_MAX_MB }: Props) {
  const { t } = useTranslation("settings");
  const maxSize = maxMB * 1024 * 1024;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Une URL par image, révoquée dès qu'elle quitte la liste : sans ça chaque pièce retirée laisse son
  // aperçu en mémoire jusqu'au rechargement de la fenêtre.
  const previews = useMemo(
    () => files.map((file) => ({ file, url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null })),
    [files],
  );
  useEffect(() => () => { for (const p of previews) if (p.url) URL.revokeObjectURL(p.url); }, [previews]);

  const add = useCallback((incoming: File[]) => {
    if (!incoming.length) return;
    if (incoming.some((f) => f.size > maxSize)) { setError(t("bugReport.validation.tooLarge", { size: maxMB })); return; }

    const next = [...files];
    for (const file of incoming) if (!next.some((f) => sameFile(f, file))) next.push(file);
    setError(next.length > maxFiles ? t("bugReport.files.limit", { count: maxFiles }) : null);
    onChange(next.slice(0, maxFiles));
  }, [files, onChange, t, maxSize, maxMB, maxFiles]);

  // Le réflexe après une capture Windows (Maj+Win+S) est Ctrl+V : sans écoute du collage, il fallait
  // d'abord enregistrer un fichier sur le disque pour pouvoir le joindre.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const pasted = [...(e.clipboardData?.files ?? [])];
      if (!pasted.length) return;
      e.preventDefault();
      add(pasted);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [add]);

  function remove(file: File) {
    setError(null);
    onChange(files.filter((f) => f !== file));
  }

  const full = files.length >= maxFiles;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{t("bugReport.files.label")}</span>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); add([...e.dataTransfer.files]); }}
        className={cn(
          "rounded-lg border border-dashed border-border p-3 transition-colors",
          dragging && "border-primary bg-primary/5",
        )}
      >
        <input
          ref={inputRef}
          id="bug-attachments"
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = ""; // sinon rechoisir le MÊME fichier n'émet plus d'évènement
          }}
        />

        {files.length > 0 && (
          <ul className="mb-3 grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
            {previews.map(({ file, url }) => {
              const Icon = iconFor(file);
              return (
                <li key={`${file.name}-${file.lastModified}`} className="group relative overflow-hidden rounded-md border border-border bg-input/30">
                  {url ? (
                    <img src={url} alt={file.name} className="aspect-video w-full object-cover" />
                  ) : (
                    <div className="flex aspect-video w-full items-center justify-center text-muted-foreground">
                      <Icon className="size-6" />
                    </div>
                  )}
                  <p className="truncate px-1.5 pt-1 text-[10px] text-foreground/80">{file.name}</p>
                  <p className="truncate px-1.5 pb-1 text-[10px] text-muted-foreground">{sizeLabel(file.size)}</p>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={() => remove(file)}
                          aria-label={t("bugReport.files.remove")}
                          className="absolute right-1 top-1 rounded-full bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        />
                      }
                    >
                      <X className="size-3" />
                    </TooltipTrigger>
                    <TooltipContent>{t("bugReport.files.remove")}</TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={full} onClick={() => inputRef.current?.click()}>
            <Paperclip className="size-3.5" /> {files.length ? t("bugReport.files.add") : t("bugReport.files.choose")}
          </Button>
          {/* Compteur seul : la bordure en pointillés porte déjà l'affordance de dépôt. */}
          {files.length > 0 && <span className="text-xs text-muted-foreground">{files.length}/{maxFiles}</span>}
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
