import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Ban, X } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from "@/components/ui/input-group";

type Props = {
  value: string;
  setValue: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
};

// Requête négative — dépliée à la demande depuis la barre (icône ⊘). Repliée par défaut : elle sert
// rarement et occupait une ligne permanente en haut de la grille.
export function ExcludeRow({ value, setValue, onSubmit, onClose }: Props) {
  const { t } = useTranslation("search");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="animate-in fade-in-0 slide-in-from-top-1 duration-150 motion-reduce:animate-none">
      <InputGroup>
        <InputGroupAddon><Ban /></InputGroupAddon>
        <InputGroupInput
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
            // Échap vide d'abord, referme ensuite : on ne masque jamais une exclusion active.
            if (e.key === "Escape") { if (value) setValue(""); else onClose(); }
          }}
          placeholder={t("searchBar.negativePlaceholder")}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label={t("searchBar.clearExclusionAria")} onClick={() => { setValue(""); onClose(); }}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
