import { Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MAX_PATCHES_CHOICES, VRAM_PROFILES, type VramProfile } from "@/lib/searchPerf";

// Accès rapide aux options de performance, là où on lance une indexation : les décocher exige
// sinon d'ouvrir les Paramètres et de perdre la sélection de rushs en cours. Mêmes réglages, même
// source (store → core/prefs) que Paramètres › IA › Indexation — jamais une seconde vérité.
export function SearchPerfMenu() {
  const { t } = useTranslation("settings");
  const perf = useApp((s) => s.searchPerf);
  const setPerf = useApp((s) => s.setSearchPerf);
  const openSettings = useApp((s) => s.openSettings);

  return (
    <DropdownMenu>
      {/* Déclencheur du menu DANS le trigger de l'infobulle (span neutre), comme le bouton
          « Réglages du modèle » juste à côté : un seul patron pour deux boutons voisins. */}
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="px-2 text-muted-foreground" />}>
            <Settings2 className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("performance.quick")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>{t("performance.quick")}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={perf.shotDecode} onCheckedChange={(shotDecode) => setPerf({ shotDecode })}>
          {t("performance.shotDecode")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={perf.onnxGpu} onCheckedChange={(onnxGpu) => setPerf({ onnxGpu })}>
          {t("performance.onnxGpu")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {/* Menu PLAT plutôt que deux sous-menus : le panneau CEP tourne sur un Chromium ancien où
            un portail imbriqué n'a jamais été éprouvé ici, et l'app doit marcher aussi là-bas. */}
        <DropdownMenuLabel>{t("performance.vramProfile")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={perf.vramProfile} onValueChange={(v) => setPerf({ vramProfile: v as VramProfile })}>
          {VRAM_PROFILES.map((profile) => (
            <DropdownMenuRadioItem key={profile} value={profile}>{t(`performance.vram.${profile}`)}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("performance.maxPatches")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={String(perf.maxPatches)} onValueChange={(v) => setPerf({ maxPatches: Number(v) })}>
          {MAX_PATCHES_CHOICES.map((value) => (
            <DropdownMenuRadioItem key={value} value={String(value)}>
              {value === 256 ? t("performance.patchesDefault", { value }) : value}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openSettings("ai", "indexing")}>{t("performance.quickMore")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
