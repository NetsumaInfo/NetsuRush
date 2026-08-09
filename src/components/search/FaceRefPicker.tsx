import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, ScanFace, Trash2, Tag } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { nr, type FaceDet, type CharMatch, type CharRef } from "@/lib/bridge";
import { useApp } from "@/store";
import type { FaceRef } from "@/store/search";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SelectCheck } from "@/components/common/selectable";
import { IMAGE_RE, ipcErr } from "@/components/search/searchHelpers";
import { NameFaceMenu } from "@/components/search/NameFaceMenu";
import { FaceModelsBanner } from "@/components/search/FaceModelsBanner";
import { basename } from "@/store/types";

// Une image analysée : chemin source + visages détectés (ou repli image entière).
interface Analyzed {
  path: string;
  faces: FaceDet[];
  error?: string | null;
}

const refKey = (r: FaceRef) => `${r.path}#${r.bbox ? r.bbox.join(",") : "full"}`;

// Vignette d'un visage détecté (ou de l'image entière en repli) : clic = (dé)sélection, bouton
// « Nommer » = enregistrer sous un personnage, badge « ≈ Nom » = suggestion du roster (clic = chercher).
function FaceCell({ thumb, domain, active, onToggle, refPayload, suggestion, onSearchChar }: {
  thumb: string | null; domain?: "anime" | "real"; active: boolean; onToggle: () => void;
  refPayload?: CharRef; suggestion?: CharMatch; onSearchChar?: () => void;
}) {
  const { t } = useTranslation("search");
  return (
    <div className="relative w-20">
      <Tooltip>
        <TooltipTrigger render={<button
          type="button"
          onClick={onToggle}
          className={cn(
            "relative block aspect-square w-full overflow-hidden rounded-lg border bg-muted transition-colors",
            active ? "border-primary ring-2 ring-primary" : "border-border hover:border-foreground/40",
          )}
        >
          {thumb ? (
            <img src={thumb} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground"><ScanFace className="h-5 w-5 opacity-40" /></div>
          )}
          {domain && (
            <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[9px] text-white">
              {domain === "anime" ? t("domain.anime") : t("domain.real")}
            </span>
          )}
          {active && <SelectCheck />}
        </button>} />
        <TooltipContent>{active ? t("faceRefPicker.removeThisFace") : t("faceRefPicker.searchThisFace")}</TooltipContent>
      </Tooltip>
      {refPayload && (
        <NameFaceMenu refPayload={refPayload} trigger={
          <button type="button" aria-label={t("faceRefPicker.nameFaceAria")}
            className="absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded bg-black/60 text-white opacity-80 hover:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <Tag className="h-3 w-3" />
          </button>
        } />
      )}
      {suggestion && (
        <Tooltip>
          <TooltipTrigger render={<button type="button" onClick={onSearchChar}
            className="mt-1 block w-full truncate rounded bg-primary/15 px-1 py-0.5 text-[10px] text-primary hover:bg-primary/25 outline-none focus-visible:ring-2 focus-visible:ring-primary" />}>
            ≈ {suggestion.name}
          </TooltipTrigger>
          <TooltipContent>{t("faceRefPicker.suggestionTooltip", { name: suggestion.name, pct: Math.round(suggestion.score * 100) })}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

// Picker de visages de référence : choisir des images → visages détectés (animé + réel) →
// cliquer LE visage du personnage à chercher (multi-images du même perso = requête plus robuste).
// Image sans visage détecté → carte « image entière » (le backend prendra le plus grand visage).
export function FaceRefPicker() {
  const { t } = useTranslation(["search", "common"]);
  const { facePicker, closeFacePicker, setFaceRefs, runFaceSearch, refreshCharacters, searchByCharacter } = useApp(
    useShallow((s) => ({
      facePicker: s.facePicker, closeFacePicker: s.closeFacePicker,
      setFaceRefs: s.setFaceRefs, runFaceSearch: s.runFaceSearch,
      refreshCharacters: s.refreshCharacters, searchByCharacter: s.searchByCharacter,
    })),
  );
  const [images, setImages] = useState<Analyzed[]>([]);
  const [sel, setSel] = useState<FaceRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [sugg, setSugg] = useState<Record<string, CharMatch>>({});   // `${path}#${faceIndex}` → suggestion

  // Roster chargé à l'ouverture (menu « Nommer » + suggestions).
  useEffect(() => { if (facePicker) void refreshCharacters(); }, [facePicker, refreshCharacters]);

  function reset() {
    setImages([]); setSel([]); setBusy(false); setSugg({});
  }

  // Compare les visages détectés au roster → badge « ≈ Nom ? ».
  async function identify(list: Analyzed[]) {
    const refs: CharRef[] = []; const keys: string[] = [];
    for (const im of list) for (const f of im.faces) {
      refs.push({ path: im.path, bbox: f.bbox, domain: f.domain }); keys.push(`${im.path}#${f.index}`);
    }
    if (!refs.length) return;
    try {
      const r = await nr.charIdentify({ refs });
      const next: Record<string, CharMatch> = {};
      (r.matches ?? []).forEach((m, i) => { if (m) next[keys[i]] = m; });
      if (Object.keys(next).length) setSugg((prev) => ({ ...prev, ...next }));
    } catch { /* suggestion non critique */ }
  }

  async function onAddImages() {
    try {
      const files = await nr.chooseImages();
      const fresh = (files ?? []).filter((p) => IMAGE_RE.test(p) && !images.some((im) => im.path === p));
      if (!fresh.length) return;
      setBusy(true);
      const out: Analyzed[] = [];
      for (const p of fresh) {
        try {
          const r = await nr.faceDetect(p);
          out.push({ path: p, faces: r.faces ?? [], error: r.error ?? null });
        } catch (e) {
          out.push({ path: p, faces: [], error: String(e) });
        }
      }
      setImages((prev) => [...prev, ...out]);
      void identify(out);
      // Confort : une seule image avec un seul visage → pré-sélectionné.
      const only = out.length === 1 && images.length === 0 && out[0].faces.length === 1 ? out[0] : null;
      if (only) {
        const f = only.faces[0];
        setSel([{ path: only.path, bbox: f.bbox, domain: f.domain, thumb: f.thumb }]);
      }
    } catch (e) { ipcErr(e); } finally { setBusy(false); }
  }

  function searchChar(charId: number, name: string) {
    closeFacePicker(); reset();
    void searchByCharacter(charId, name);
  }

  function toggle(ref: FaceRef) {
    setSel((prev) => {
      const k = refKey(ref);
      return prev.some((r) => refKey(r) === k) ? prev.filter((r) => refKey(r) !== k) : [...prev, ref];
    });
  }
  const isSel = (ref: FaceRef) => sel.some((r) => refKey(r) === refKey(ref));

  async function onSearch() {
    setFaceRefs(sel);
    closeFacePicker();
    reset();
    await runFaceSearch();
  }

  return (
    <Dialog open={facePicker} onOpenChange={(o) => { if (!o) { closeFacePicker(); reset(); } }}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t("faceRefPicker.title")}</DialogTitle>
        <p className="text-xs text-muted-foreground">
          {t("faceRefPicker.hint")}
        </p>

        <FaceModelsBanner />

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onAddImages} disabled={busy}>
            {busy ? <Spinner className="h-4 w-4" /> : <ImagePlus className="h-4 w-4" />}
            {t("faceRefPicker.addImage")}
          </Button>
          {images.length > 0 && (
            <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
              <Trash2 className="h-4 w-4" />
              {t("faceRefPicker.clearImages")}
            </Button>
          )}
          {sel.length > 0 && <Badge>{t("faceRefPicker.facesChosen", { count: sel.length })}</Badge>}
        </div>

        <div className="max-h-80 space-y-3 overflow-y-auto">
          {images.map((im) => (
            <div key={im.path} className="space-y-1.5">
              <div className="truncate text-xs text-muted-foreground">{basename(im.path)}</div>
              {im.error ? (
                <div className="text-xs text-destructive">{im.error}</div>
              ) : im.faces.length === 0 ? (
                <div className="flex items-start gap-2">
                  <FaceCell
                    thumb={nr.mediaUrl(im.path)}
                    active={isSel({ path: im.path })}
                    onToggle={() => toggle({ path: im.path, thumb: nr.mediaUrl(im.path) })}
                    refPayload={{ path: im.path }}
                  />
                  <span className="text-xs text-muted-foreground">{t("faceRefPicker.noFaceDetected")}</span>
                </div>
              ) : (
                <div className="flex flex-wrap items-start gap-2">
                  {im.faces.map((f) => (
                    <FaceCell
                      key={f.index}
                      thumb={f.thumb}
                      domain={f.domain}
                      active={isSel({ path: im.path, bbox: f.bbox, domain: f.domain })}
                      onToggle={() => toggle({ path: im.path, bbox: f.bbox, domain: f.domain, thumb: f.thumb })}
                      refPayload={{ path: im.path, bbox: f.bbox, domain: f.domain }}
                      suggestion={sugg[`${im.path}#${f.index}`]}
                      onSearchChar={() => { const m = sugg[`${im.path}#${f.index}`]; if (m) searchChar(m.char_id, m.name); }}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          {images.length === 0 && !busy && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
              <ScanFace className="h-7 w-7 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{t("faceRefPicker.noImages")}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => { closeFacePicker(); reset(); }}>{t("common:action.cancel")}</Button>
          <Button size="sm" onClick={onSearch} disabled={sel.length === 0 || busy}>
            <ScanFace className="h-4 w-4" />
            {t("faceRefPicker.search")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
