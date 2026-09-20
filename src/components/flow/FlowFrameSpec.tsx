// Le harnais du cahier de design, dans le panneau IA.
//
// Deux états, un seul rôle : soit une zone où déposer un `frame.md`, soit la
// pastille du cahier actif. Il vit avec le composer et pas dans les réglages,
// parce qu'il fait partie de la demande : c'est ce qui distingue « fais-moi une
// animation » de « fais-moi une animation DANS CETTE CHARTE ».
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { FrameSpec } from "@/components/flow/useFrameSpec";

export function FlowFrameSpec({ spec, error, onLoad, onClear }: {
  spec: FrameSpec | null;
  error: string;
  onLoad: (file: File) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation("flow");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  // Le dépôt de fichier passe par le glisser-déposer HTML : la fenêtre Tauri
  // laisse `dragDropEnabled` à false, donc c'est bien la page qui reçoit
  // l'évènement et non la coquille native.
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onLoad(file);
  };

  // `dragover` doit être annulé, sinon le navigateur refuse le dépôt et ouvre
  // le fichier à la place — en remplaçant la page par son contenu.
  const dragOver = (event: React.DragEvent) => {
    event.preventDefault();
    const item = event.dataTransfer.items?.[0];
    // Pendant le survol le nom n'est pas lisible : on ne peut que voir que
    // c'est un fichier. Le tri par extension se fait au dépôt.
    setOver(!item || item.kind === "file");
  };

  if (spec) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1">
        <FileText className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px]">
          <Tooltip>
            <TooltipTrigger render={<span className="cursor-default" />}>{spec.name}</TooltipTrigger>
            <TooltipContent>{t("frameSpecActive", { size: Math.max(1, Math.round(spec.text.length / 1024)) })}</TooltipContent>
          </Tooltip>
        </span>
        <Tooltip>
          <TooltipTrigger render={
            <Button
              size="icon"
              variant="ghost"
              className="size-5 shrink-0"
              onClick={onClear}
              aria-label={t("frameSpecRemove")}
            >
              <X className="size-3" />
            </Button>
          } />
          <TooltipContent>{t("frameSpecRemove")}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDrop={drop}
        onDragOver={dragOver}
        onDragLeave={() => setOver(false)}
        className={cn(
          "flex items-center justify-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-[11px] transition-colors",
          over
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
        )}
      >
        <Upload className="size-3.5 shrink-0" />
        {t("frameSpecDrop")}
      </button>
      <input
        ref={input}
        type="file"
        // Un filtre, pas une garantie : le sélecteur du système laisse choisir
        // « tous les fichiers », et le dépôt ne passe pas par lui du tout. Le
        // tri réel est dans `looksLikeSpec`.
        accept=".md,.markdown,.mdx,.txt,.yaml,.yml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onLoad(file);
          // Remis à zéro pour que redéposer LE MÊME fichier redéclenche
          // l'évènement — sinon corriger son frame.md et le recharger ne ferait
          // rien du tout.
          event.target.value = "";
        }}
      />
      {error ? <p className="px-1 text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
