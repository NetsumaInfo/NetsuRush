// Global approval surface for external agents (Claude Desktop, Codex…). Mounted once at the app
// root so a request is answerable wherever the user is; queued, since several can arrive at once.
import { useTranslation } from "react-i18next";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useExternalApprovals, type ExternalApproval } from "@/hooks/useExternalApprovals";

const MS_PER_SECOND = 1000;

interface InputShape { action?: unknown }

function actionOf(input: unknown): string | null {
  const action = (input as InputShape | null)?.action;
  return typeof action === "string" ? action : null;
}

function ApprovalCard({ item, now, onRespond }: {
  item: ExternalApproval;
  now: number;
  onRespond: (callId: number, approved: boolean) => void;
}) {
  const { t } = useTranslation("chat");
  const { request } = item;
  const action = actionOf(request.input);
  const secondsLeft = Math.max(0, Math.ceil((item.expiresAt - now) / MS_PER_SECOND));

  return (
    <div className="pointer-events-auto w-96 rounded-lg border border-[var(--color-warn)]/40 bg-card p-3 shadow-lg">
      <div className="flex items-center gap-2 text-sm font-medium">
        <NetsuIcon name="chat-approve" className="size-4 shrink-0 text-[var(--color-warn)]" />
        <span className="min-w-0 flex-1 truncate">{t("externalApproval.title")}</span>
        <Badge variant="outline">{t(`risk.${request.risk}`, { defaultValue: request.risk })}</Badge>
      </div>
      <div className="mt-1.5 font-mono text-xs text-muted-foreground">
        {request.name}{action ? <span> · {action}</span> : null}
      </div>
      <Accordion>
        <AccordionItem value="input" className="border-b-0">
          <AccordionTrigger className="py-1.5 text-xs">{t("externalApproval.input")}</AccordionTrigger>
          <AccordionContent>
            <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 text-[0.6875rem] break-all whitespace-pre-wrap">
              {JSON.stringify(request.input, null, 2)}
            </pre>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <div className="mt-1.5 flex items-center gap-2">
        <Button size="sm" onClick={() => onRespond(request.callId, true)}>
          <NetsuIcon name="check" className="size-3.5" /> {t("approval.allow")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onRespond(request.callId, false)}>
          <NetsuIcon name="close" className="size-3.5" /> {t("approval.deny")}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{t("externalApproval.countdown", { count: secondsLeft })}</span>
      </div>
    </div>
  );
}

export function ExternalApprovalHost() {
  const { pending, now, respond } = useExternalApprovals();
  if (pending.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex max-h-[80vh] flex-col gap-2 overflow-y-auto">
      {pending.map((item) => (
        <ApprovalCard key={item.request.callId} item={item} now={now} onRespond={respond} />
      ))}
    </div>
  );
}
