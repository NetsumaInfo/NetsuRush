import { Mic, Square, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useDictation } from "./useDictation";

// Bouton de dictée réutilisable (barre d'outils d'un éditeur OU FAB global). `onText` reçoit le texte
// transcrit ; le langage suit le type de contenu voix (persisté). Rouge pulsé pendant l'enregistrement.
export function DictateButton({ onText, size = "icon-sm", lang = "fr" }: {
  onText: (t: string) => void;
  size?: "icon-sm" | "icon";
  lang?: string;
}) {
  const { t } = useTranslation("dictate");
  // Réutilise le modèle ASR choisi pour la voix (whisper-turbo par défaut).
  const model = useApp((s) => s.asrModel);
  const { state, err, toggle } = useDictation(onText, { lang, model });
  const recording = state === "recording";
  const busy = state === "transcribing";

  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          variant={recording ? "default" : "ghost"}
          size={size}
          onClick={toggle}
          disabled={busy}
          aria-label={recording ? t("button.ariaStop") : t("button.ariaDictate")}
          aria-pressed={recording}
          className={recording ? "animate-pulse bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </Button>
      } />
      <TooltipContent>{err ? err : busy ? t("transcribing") : recording ? t("button.tooltipStop") : t("button.tooltipDictate")}</TooltipContent>
    </Tooltip>
  );
}
