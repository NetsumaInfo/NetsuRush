// Gabarit du nom des fichiers d'un profil d'export : champ de saisie + menu d'insertion de jetons +
// aperçu du nom réel. L'aperçu et la liste des jetons viennent du CORE (`export:previewName`), qui
// résout le gabarit avec le même code que l'export — un résolveur recopié ici finirait par annoncer
// un nom que l'export n'écrit pas.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Braces } from "lucide-react";
import { nr, type ExportNamePreview } from "@/lib/bridge";
import { type ExportProfile } from "@/features/export/profiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

// L'aperçu part au repos de frappe, pas à chaque caractère : le gabarit se tape jeton par jeton et
// un appel par touche n'apprendrait rien de plus.
const PREVIEW_DEBOUNCE_MS = 150;

export function ExportNaming({
  profile,
  onChange,
  disabled,
}: {
  profile: ExportProfile;
  onChange: (naming: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("export");
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ExportNamePreview | null>(null);
  // Position où replacer le curseur après une insertion : sans elle, le caret saute en fin de champ
  // et insérer deux jetons de suite devient impossible.
  const [caret, setCaret] = useState<number | null>(null);

  const template = profile.naming ?? "";

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void nr.exportPreviewName({ profile }).then((r) => { if (alive) setPreview(r); }).catch(() => { if (alive) setPreview(null); });
    }, PREVIEW_DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [profile]);

  useLayoutEffect(() => {
    if (caret == null) return;
    inputRef.current?.setSelectionRange(caret, caret);
    inputRef.current?.focus();
    setCaret(null);
  }, [caret]);

  function insertToken(token: string) {
    const el = inputRef.current;
    const tag = `{${token}}`;
    const from = el?.selectionStart ?? template.length;
    const to = el?.selectionEnd ?? template.length;
    onChange(`${template.slice(0, from)}${tag}${template.slice(to)}`);
    setCaret(from + tag.length);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[0.8125rem] text-muted-foreground">{t("editor.fileName")}</span>
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          value={template}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("editor.fileNamePlaceholder")}
          disabled={disabled}
          className="flex-1 font-mono text-xs"
          spellCheck={false}
        />
        {/* Jetons déclarés par le core : en ajouter un là-bas le fait apparaître ici sans rien câbler. */}
        {!!preview?.tokens.length && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon" disabled={disabled} aria-label={t("editor.insertToken")}>
                  <Braces className="size-4" />
                </Button>} />
              </TooltipTrigger>
              <TooltipContent>{t("editor.insertToken")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("editor.insertToken")}</DropdownMenuLabel>
                {preview.tokens.map((token) => (
                  <DropdownMenuItem key={token} onClick={() => insertToken(token)}>
                    <span className="font-mono text-xs">{`{${token}}`}</span>
                    <span className="ml-auto pl-3 text-muted-foreground">{t(`editor.tokens.${token}`, { defaultValue: token })}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {/* Le nom fusionné n'est montré QUE si le profil fusionne : le gabarit s'y résout sans index,
          donc le même gabarit ne donne pas le même nom dans les deux cas. */}
      {!!preview?.name && (
        <Tooltip>
          <TooltipTrigger render={
            <span className="truncate font-mono text-[0.75rem] text-muted-foreground">
              {profile.mergeEnabled ? preview.merged : preview.name}
            </span>
          } />
          <TooltipContent>{profile.mergeEnabled ? preview.merged : preview.name}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
