// State of the external-agents (MCP) settings: the server state from the core, kept current by the
// live activity stream.
import { useCallback, useEffect, useState } from "react";
import { nr, type McpActivity, type McpClientId, type McpExternalState } from "@/lib/bridge";
import { errorText } from "@/lib/errorText";

export const RECENT_LIMIT = 20;

export function useExternalAgents() {
  const [state, setState] = useState<McpExternalState | null>(null);
  const [busyClient, setBusyClient] = useState<McpClientId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void nr.mcp?.get().then((next) => { if (!cancelled) setState(next); }).catch((e) => setError(errorText(e)));
    const off = nr.mcp?.onActivity((activity: McpActivity) => {
      setState((current) => (current ? { ...current, recent: [activity, ...current.recent].slice(0, RECENT_LIMIT) } : current));
    });
    const offChanged = nr.mcp?.onChanged((next) => { if (!cancelled) setState(next); });
    return () => { cancelled = true; off?.(); offChanged?.(); };
  }, []);

  const patch = useCallback(async (change: { enabled?: boolean; mode?: McpExternalState["mode"]; maxSubagents?: number }) => {
    setError(null);
    try {
      const next = await nr.mcp?.set(change);
      if (next) setState(next);
    } catch (e) { setError(errorText(e)); }
  }, []);

  const toggleClient = useCallback(async (id: McpClientId, installed: boolean) => {
    setBusyClient(id);
    setError(null);
    try {
      const result = installed ? await nr.mcp?.uninstall(id) : await nr.mcp?.install(id);
      if (result && !result.ok) setError(result.error ?? "");
      const next = await nr.mcp?.get();
      if (next) setState(next);
    } catch (e) { setError(errorText(e)); }
    finally { setBusyClient(null); }
  }, []);

  return { state, busyClient, error, patch, toggleClient };
}
