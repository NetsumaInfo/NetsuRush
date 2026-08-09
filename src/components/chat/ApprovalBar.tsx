// Demande d'approbation : l'IA veut exécuter une action gardée (écriture / destructive). L'utilisateur
// autorise ou refuse. Affichée tant qu'une demande est en attente (chatApproval).
import { ShieldQuestion, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function ApprovalBar() {
  const { t } = useTranslation("chat");
  const approval = useApp((s) => s.chatApproval);
  const respond = useApp((s) => s.chatRespondApproval);
  if (!approval) return null;
  let args = "";
  try { args = JSON.stringify(approval.input); } catch { /* noop */ }
  return (
    <div className="mx-3 mb-2 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/15 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldQuestion className="size-4 text-[var(--color-warn)]" />
        {t("approval.title")}
        <Badge variant="outline" className="ml-1">{t(`risk.${approval.risk}`, { defaultValue: approval.risk })}</Badge>
      </div>
      <div className="mt-1.5 font-mono text-xs text-muted-foreground">
        {approval.name}{args && args !== "{}" ? <span className="break-all"> · {args.length > 200 ? args.slice(0, 200) + "…" : args}</span> : null}
      </div>
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" onClick={() => respond(true)}><Check className="size-3.5" /> {t("approval.allow")}</Button>
        <Button size="sm" variant="outline" onClick={() => respond(false)}><X className="size-3.5" /> {t("approval.deny")}</Button>
      </div>
    </div>
  );
}
