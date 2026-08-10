import { forwardRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { NotebookKind, NotebookLanguage, NotebookMeta } from "./notebookShared";

const NOTEBOOK_KINDS: NotebookKind[] = ["notes", "project", "script", "research", "journal"];
const NOTEBOOK_LANGUAGES: NotebookLanguage[] = ["fr", "en", "es", "de", "ja", "zh"];

const NotebookMetaControls = forwardRef<HTMLInputElement, { notebook: NotebookMeta }>(function NotebookMetaControls({ notebook }, ref) {
  const { t } = useTranslation("notebook");
  const rename = useApp((s) => s.nbRenameNotebook);
  const [title, setTitle] = useState(notebook.title);

  useEffect(() => setTitle(notebook.title), [notebook.id, notebook.title]);

  const saveTitle = () => {
    const next = title.trim();
    if (!next) setTitle(notebook.title);
    else if (next !== notebook.title) void rename(notebook.id, { title: next });
  };

  return (
    <div className="space-y-1.5 px-2 pb-2">
      <Input
        ref={ref}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={saveTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
          if (event.key === "Escape") { setTitle(notebook.title); event.currentTarget.blur(); }
        }}
        aria-label={t("meta.name")}
        className="h-8 border-transparent bg-transparent px-2 font-semibold shadow-none hover:border-border focus-visible:bg-card"
      />
      <div className="grid grid-cols-2 gap-1.5">
        <Select
          value={notebook.kind}
          onValueChange={(value) => void rename(notebook.id, { kind: value as NotebookKind })}
          items={NOTEBOOK_KINDS.map((value) => ({ value, label: t(`meta.kind.${value}`) }))}
        >
          <SelectTrigger size="sm" aria-label={t("meta.type")}><SelectValue /></SelectTrigger>
          <SelectContent>{NOTEBOOK_KINDS.map((value) => <SelectItem key={value} value={value}>{t(`meta.kind.${value}`)}</SelectItem>)}</SelectContent>
        </Select>
        <Select
          value={notebook.language}
          onValueChange={(value) => void rename(notebook.id, { language: value as NotebookLanguage })}
          items={NOTEBOOK_LANGUAGES.map((value) => ({ value, label: t(`meta.language.${value}`) }))}
        >
          <SelectTrigger size="sm" aria-label={t("meta.languageLabel")}><SelectValue /></SelectTrigger>
          <SelectContent>{NOTEBOOK_LANGUAGES.map((value) => <SelectItem key={value} value={value}>{t(`meta.language.${value}`)}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
  );
});

export function EditNotebookDialog({ notebook, open, onOpenChange }: { notebook: NotebookMeta; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("notebook");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("edit.title")}</DialogTitle>
          <DialogDescription>{t("edit.description")}</DialogDescription>
        </DialogHeader>
        <NotebookMetaControls notebook={notebook} />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("edit.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateNotebookDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation("notebook");
  const create = useApp((s) => s.nbCreateNotebook);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<NotebookKind>("notes");
  const initialLanguage = NOTEBOOK_LANGUAGES.includes(i18n.language.split("-")[0] as NotebookLanguage)
    ? i18n.language.split("-")[0] as NotebookLanguage
    : "fr";
  const [language, setLanguage] = useState<NotebookLanguage>(initialLanguage);

  useEffect(() => {
    if (open) { setTitle(""); setKind("notes"); setLanguage(initialLanguage); }
  }, [initialLanguage, open]);

  const submit = async () => {
    const name = title.trim();
    if (!name) return;
    const id = await create(name, kind, language);
    if (id) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>{t("create.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">{t("meta.name")}</span>
            <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit(); }} placeholder={t("create.namePlaceholder")} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">{t("meta.type")}</span>
              <Select value={kind} onValueChange={(value) => setKind(value as NotebookKind)} items={NOTEBOOK_KINDS.map((value) => ({ value, label: t(`meta.kind.${value}`) }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{NOTEBOOK_KINDS.map((value) => <SelectItem key={value} value={value}>{t(`meta.kind.${value}`)}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">{t("meta.languageLabel")}</span>
              <Select value={language} onValueChange={(value) => setLanguage(value as NotebookLanguage)} items={NOTEBOOK_LANGUAGES.map((value) => ({ value, label: t(`meta.language.${value}`) }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{NOTEBOOK_LANGUAGES.map((value) => <SelectItem key={value} value={value}>{t(`meta.language.${value}`)}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("create.cancel")}</Button>
          <Button onClick={() => void submit()} disabled={!title.trim()}>{t("create.submit")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
