import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import releases from "@/data/releases.json";
import { useUpdater } from "@/store/updater";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function UpdateBootstrap() {
  const { t, i18n } = useTranslation("settings");
  const autoCheck = useUpdater((state) => state.autoCheck);
  const check = useUpdater((state) => state.check);
  const language = i18n.language.startsWith("fr") ? "fr" : "en";
  const latest = useMemo(() => releases[0], []);
  const [open, setOpen] = useState(() => {
    try { return !!latest && localStorage.getItem("nr.release.seen") !== latest.id; } catch { return false; }
  });

  useEffect(() => {
    if (!autoCheck) return;
    const timer = window.setTimeout(() => { void check(); }, 4_000);
    return () => window.clearTimeout(timer);
  }, [autoCheck, check]);

  function close() {
    try { localStorage.setItem("nr.release.seen", latest.id); } catch { /* noop */ }
    setOpen(false);
  }

  if (!latest) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else setOpen(true); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("updates.whatsNew", { version: latest.version })}</DialogTitle>
          <DialogDescription>{latest.title[language]}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          {latest.highlights[language].map((highlight) => <li key={highlight}>{highlight}</li>)}
        </ul>
        <DialogFooter><Button onClick={close}>{t("updates.gotIt")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

