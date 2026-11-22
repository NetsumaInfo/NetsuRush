// Approval requests raised by external agents (MCP clients such as Claude Desktop or Codex). They
// share the `chat:approval` channel with the in-app chat, tagged `runId === "external"`, and must
// be answerable wherever the user is in the app.
import { useCallback, useEffect, useState } from "react";
import { nr, type ChatApprovalReq } from "@/lib/bridge";

export const EXTERNAL_RUN_ID = "external";
/** The core auto-denies an unanswered request after this delay. */
export const EXTERNAL_APPROVAL_TIMEOUT_MS = 120_000;
const TICK_MS = 1000;

export interface ExternalApproval {
  request: ChatApprovalReq;
  expiresAt: number;
}

export function useExternalApprovals() {
  const [pending, setPending] = useState<ExternalApproval[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => nr.chat?.onApproval((request) => {
    if (request.runId !== EXTERNAL_RUN_ID) return;
    const expiresAt = Date.now() + EXTERNAL_APPROVAL_TIMEOUT_MS;
    setPending((list) => [...list.filter((p) => p.request.callId !== request.callId), { request, expiresAt }]);
  }), []);

  useEffect(() => {
    if (pending.length === 0) return;
    const timer = window.setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      setPending((list) => (list.some((p) => p.expiresAt <= tick) ? list.filter((p) => p.expiresAt > tick) : list));
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [pending.length]);

  const respond = useCallback((callId: number, approved: boolean) => {
    void nr.chat?.respondApproval(callId, approved);
    setPending((list) => list.filter((p) => p.request.callId !== callId));
  }, []);

  return { pending, now, respond };
}
