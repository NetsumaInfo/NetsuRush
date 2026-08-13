// Export du board en IMAGE (PNG/JPG) ou en SVG.
//
// Le rendu ne capture pas le DOM : il repart du modèle (cf. `boardRender`). La taille proposée est
// celle du contenu plus une marge de 3 %, et le ratio est verrouillé — on choisit une définition,
// pas un cadrage. Le SVG, lui, sort à sa taille naturelle : c'est du vectoriel, il se redimensionne
// après coup sans rien perdre.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileImage, FileCode2 } from "lucide-react";
import { nr } from "@/lib/bridge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { useBoard } from "./useReferenceBoard";
import { defaultExportSize, renderBoardCanvas, renderBoardSvg } from "./boardRender";

type Format = "png" | "jpg" | "svg";

export function ExportImageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation("reference");
  const items = useBoard((s) => s.items);
  const selectedIds = useBoard((s) => s.selectedIds);
  const sceneName = useBoard((s) => s.sceneName);
  const setNotice = useBoard((s) => s.setNotice);

  const [format, setFormat] = useState<Format>("png");
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [transparent, setTransparent] = useState(false);
  const [width, setWidth] = useState(0);
  const [busy, setBusy] = useState(false);

  const only = useMemo(
    () => (selectionOnly && selectedIds.length ? new Set(selectedIds) : undefined),
    [selectionOnly, selectedIds],
  );
  const natural = useMemo(() => defaultExportSize(items, only), [items, only]);
  const ratio = natural.h ? natural.w / natural.h : 1;
  const height = Math.max(1, Math.round((width || natural.w) / ratio));

  // La taille naturelle change avec le contenu ou la portée : on repart d'elle à chaque ouverture.
  useEffect(() => { if (open) setWidth(natural.w); }, [open, natural.w]);
  useEffect(() => { if (!selectedIds.length) setSelectionOnly(false); }, [selectedIds.length]);

  const run = async () => {
    setBusy(true);
    try {
      const base = (sceneName || "board").replace(/[\\/:*?"<>|]+/g, "_");
      const dest = await nr.saveFile(`${base}.${format}`);
      if (!dest) return;

      const background = transparent && format === "png" ? null : "var(--color-bg)";
      // Le fond du board est une variable CSS : le canvas veut une couleur réelle.
      const resolved = background
        ? getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim() || "#0b0b0e"
        : null;

      // Sans pont applicatif (mode navigateur), il n'y a pas d'écriture disque : le dire plutôt que
      // laisser l'assertion exploser sur un objet absent.
      const write = nr.reference?.writeFile;
      if (!write) throw new Error(t("exportImage.noBridge"));

      if (format === "svg") {
        const svg = await renderBoardSvg(items, { background: resolved, only });
        const res = await write(dest, svg, "utf8");
        if (!res.ok) throw new Error(res.error || "write failed");
      } else {
        const canvas = await renderBoardCanvas(items, { width, background: resolved, only });
        const dataUrl = canvas.toDataURL(format === "jpg" ? "image/jpeg" : "image/png", 0.92);
        const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const res = await write(dest, b64, "base64");
        if (!res.ok) throw new Error(res.error || "write failed");
      }
      setNotice({ kind: "ok", text: t("exportImage.done") });
      onOpenChange(false);
    } catch (e) {
      setNotice({ kind: "error", text: t("exportImage.failed", { error: String(e) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("exportImage.title")}</DialogTitle>
          <DialogDescription>{t("exportImage.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex gap-1.5">
            <Button variant={format === "png" ? "default" : "outline"} size="sm" className="flex-1 gap-1.5" onClick={() => setFormat("png")}>
              <FileImage className="size-3.5" /> PNG
            </Button>
            <Button variant={format === "jpg" ? "default" : "outline"} size="sm" className="flex-1 gap-1.5" onClick={() => setFormat("jpg")}>
              <FileImage className="size-3.5" /> JPG
            </Button>
            <Button variant={format === "svg" ? "default" : "outline"} size="sm" className="flex-1 gap-1.5" onClick={() => setFormat("svg")}>
              <FileCode2 className="size-3.5" /> SVG
            </Button>
          </div>

          {format !== "svg" && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="nr-export-w" className="text-xs text-muted-foreground">{t("exportImage.width")}</Label>
                <Input
                  id="nr-export-w"
                  type="number"
                  min={16}
                  max={20000}
                  value={width || ""}
                  onChange={(e) => setWidth(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
              <span className="pb-2 text-muted-foreground">×</span>
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground">{t("exportImage.height")}</Label>
                <Input value={height} readOnly tabIndex={-1} />
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {!!selectedIds.length && (
              <div className="flex items-center gap-2">
                <Checkbox id="nr-export-sel" checked={selectionOnly} onCheckedChange={(v) => setSelectionOnly(!!v)} />
                <Label htmlFor="nr-export-sel" className="text-sm font-normal">
                  {t("exportImage.selectionOnly", { count: selectedIds.length })}
                </Label>
              </div>
            )}
            {format === "png" && (
              <div className="flex items-center gap-2">
                <Checkbox id="nr-export-bg" checked={transparent} onCheckedChange={(v) => setTransparent(!!v)} />
                <Label htmlFor="nr-export-bg" className="text-sm font-normal">{t("exportImage.transparent")}</Label>
              </div>
            )}
          </div>

          <p className="text-xs leading-snug text-muted-foreground">{t("exportImage.hint")}</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t("common:action.cancel")}</Button>
          <Button onClick={() => void run()} disabled={busy}>
            {busy && <Spinner />}
            {t("exportImage.export")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
