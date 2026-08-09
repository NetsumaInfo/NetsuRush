import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Petit dialog nom-de-dossier (créer / renommer un dossier de rangement de collections).
export function FolderNameDialog({ open, initial, title, onSubmit, onCancel }: {
  open: boolean;
  initial: string;
  title: string;
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["collections", "common"]);
  const [name, setName] = useState(initial);
  useEffect(() => { if (open) setName(initial); }, [open, initial]);
  const submit = () => { const n = name.trim(); if (n) void onSubmit(n); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") submit(); }} placeholder={t("folder.namePlaceholder")} />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{t("common:action.cancel")}</Button>
          <Button onClick={submit} disabled={!name.trim()}>{t("common:action.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
