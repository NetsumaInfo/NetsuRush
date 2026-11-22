// "Connect external AI apps": exposes NetsuRush to MCP clients (Claude Desktop, Claude Code, Codex,
// Cursor) through its own MCP server. The permission mode gates what those agents may change; the
// confirmations they trigger surface globally (ExternalApprovalHost).
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { toast } from "@/components/ui/toast";
import { nr, type McpPermissionMode } from "@/lib/bridge";
import { errorText } from "@/lib/errorText";
import { CompactSelect, SectionTitle, SettingRow, type Choice } from "./rows";
import { McpClientRow } from "./mcp/McpClientRow";
import { McpRecentActivity } from "./mcp/McpRecentActivity";
import { useExternalAgents } from "./mcp/useExternalAgents";

const MODES: McpPermissionMode[] = ["read-only", "ask", "auto"];
const MAX_SUBAGENTS = 64;

async function copySnippet(copiedMessage: string) {
  try {
    const snippet = await nr.mcp?.snippet();
    if (!snippet) return;
    await navigator.clipboard.writeText(snippet.json);
    toast.ok(copiedMessage);
  } catch (e) {
    toast.error(errorText(e));
  }
}

export function ExternalAgentsSettings() {
  const { t } = useTranslation("settings");
  const { state, busyClient, error, patch, toggleClient } = useExternalAgents();

  if (!state) return <SectionTitle title={t("mcp.title")} info={t("mcp.subtitle")} />;

  const modeChoices: Choice<McpPermissionMode>[] = MODES.map((value) => ({ value, label: t(`mcp.mode.${value}`) }));

  return (
    <section className="flex flex-col gap-7">
      <SectionTitle title={t("mcp.title")} info={t("mcp.subtitle")} />

      <div className="divide-y divide-border rounded-lg border border-border">
        <SettingRow label={t("mcp.enable")} hint={t("mcp.enableHint")}>
          <Toggle className="ml-auto flex" pressed={state.enabled} onPressedChange={(enabled) => void patch({ enabled })}>
            {state.enabled ? t("mcp.on") : t("mcp.off")}
          </Toggle>
        </SettingRow>
        <SettingRow label={t("mcp.modeLabel")} hint={t("mcp.modeHint")}>
          <CompactSelect value={state.mode} choices={modeChoices} onChange={(mode) => void patch({ mode })} disabled={!state.enabled} />
        </SettingRow>
        <SettingRow label={t("mcp.maxSubagents")} hint={t("mcp.maxSubagentsHint")}>
          <Input
            key={state.maxSubagents}
            type="number"
            min={1}
            max={MAX_SUBAGENTS}
            defaultValue={state.maxSubagents}
            onBlur={(e) => {
              const value = Number(e.target.value);
              if (value >= 1 && value !== state.maxSubagents) void patch({ maxSubagents: value });
            }}
            className="ml-auto h-8 w-20"
          />
        </SettingRow>
      </div>

      <div>
        <SectionTitle as="h3" title={t("mcp.clients")} />
        <div className="mt-2 divide-y divide-border rounded-lg border border-border">
          {state.clients.map((client) => (
            <McpClientRow
              key={client.id}
              client={client}
              busy={busyClient === client.id}
              onToggle={() => void toggleClient(client.id, client.installed)}
            />
          ))}
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => void copySnippet(t("mcp.copied"))}>
            <NetsuIcon name="copy" className="size-3.5" /> {t("mcp.copyJson")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("mcp.restartNote")}</p>
        </div>
      </div>

      <div>
        <SectionTitle as="h3" title={t("mcp.recent")} />
        <div className="mt-2"><McpRecentActivity recent={state.recent} /></div>
      </div>
    </section>
  );
}
