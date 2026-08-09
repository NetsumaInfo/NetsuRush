// Bouton de la barre de mise en forme (sélection de texte) « Lien vers une page »
// (sélectionner du texte → le lier à une autre page). Ouvre un popover de recherche des pages du
// carnet ; au choix, enveloppe la sélection dans un lien interne `nbpage:<id>` (intercepté au clic
// dans NoteEditor → ouvre la page). Les liens URL externes restent gérés par le bouton natif (Ctrl+K).
import { useMemo, useState } from "react";
import { FileSymlink, Link2, Globe, FileText } from "lucide-react";
import { useComponentsContext, useBlockNoteEditor } from "@blocknote/react";
import { useApp } from "@/store";
import { NBPAGE_LINK_PREFIX } from "./notebookShared";
import i18n from "@/i18n";

export { NBPAGE_LINK_PREFIX };

// Normalise une saisie en URL web : http(s)://… tel quel, sinon www./domaine.tld → https://…
function toWebUrl(raw: string): string | null {
  const s = raw.trim();
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^www\.\S+\.\S+/i.test(s) || /^[\w-]+\.\w{2,}(\/\S*)?$/i.test(s)) return `https://${s}`;
  return null;
}

export function LinkToPageButton() {
  const editor = useBlockNoteEditor<any, any, any>();
  const Components = useComponentsContext()!;
  const pages = useApp((s) => s.nbPages);
  const activePageId = useApp((s) => s.nbActivePageId);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selText, setSelText] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pages
      .filter((p) => p.id !== activePageId && (!q || (p.title || "").toLowerCase().includes(q)))
      .slice(0, 8);
  }, [pages, activePageId, query]);

  const webUrl = toWebUrl(query);

  const linkToPage = (id: string, title: string) => {
    editor.focus();
    // Enveloppe la sélection (texte conservé) dans un lien interne ; sinon insère le titre lié.
    editor.createLink(`${NBPAGE_LINK_PREFIX}${id}`, selText || title || "page");
    setOpen(false);
    setQuery("");
  };

  const linkToWeb = (url: string) => {
    editor.focus();
    editor.createLink(url, selText || url);
    setOpen(false);
    setQuery("");
  };

  return (
    <Components.Generic.Popover.Root
      open={open}
      onOpenChange={(o: boolean) => { if (o) setSelText(editor.getSelectedText()); setOpen(o); setQuery(""); }}
    >
      <Components.Generic.Popover.Trigger>
        <Components.FormattingToolbar.Button
          className="bn-button"
          label={i18n.t("notebook:paste.url.label")}
          mainTooltip={i18n.t("notebook:linkPage.tooltip")}
          icon={<FileSymlink size={18} />}
          onClick={() => setOpen((v) => !v)}
        />
      </Components.Generic.Popover.Trigger>
      <Components.Generic.Popover.Content className="bn-popover-content bn-form-popover" variant="form-popover">
        <div className="flex w-72 flex-col gap-1 p-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (webUrl) linkToWeb(webUrl);
                else if (matches[0]) linkToPage(matches[0].id, matches[0].title);
              } else if (e.key === "Escape") setOpen(false);
            }}
            placeholder={i18n.t("notebook:linkPage.placeholder")}
            className="w-full rounded border border-border bg-muted px-2 py-1 text-sm outline-none"
          />
          <div className="max-h-56 overflow-y-auto">
            {/* Lien web direct si la saisie ressemble à une URL */}
            {webUrl && (
              <button
                type="button"
                onClick={() => linkToWeb(webUrl)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <Globe className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate">{i18n.t("notebook:linkPage.linkTo")} <span className="text-muted-foreground">{webUrl}</span></span>
              </button>
            )}
            {webUrl && matches.length > 0 && <div className="my-1 border-t border-border" />}
            {matches.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => linkToPage(p.id, p.title)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">{p.icon || <FileText className="h-3.5 w-3.5" />}</span>
                <span className="truncate">{p.title || i18n.t("notebook:panel.untitled")}</span>
              </button>
            ))}
            {!webUrl && matches.length === 0 && (
              <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
                <Link2 className="h-3.5 w-3.5" /> {i18n.t("notebook:linkPage.hint")}
              </div>
            )}
          </div>
        </div>
      </Components.Generic.Popover.Content>
    </Components.Generic.Popover.Root>
  );
}
