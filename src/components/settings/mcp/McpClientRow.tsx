// One MCP client (Claude Desktop, Codex…): its status and the install / remove action.
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { McpClientInfo } from "@/lib/bridge";

export function McpClientRow({ client, busy, onToggle }: {
  client: McpClientInfo;
  busy: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("settings");
  const status = client.installed ? "installed" : client.detected ? "detected" : "notDetected";
  return (
    <div className="flex items-center justify-between gap-5 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger render={<span className="truncate text-[0.8125rem] font-medium" />}>{client.label}</TooltipTrigger>
          <TooltipContent className="max-w-96 break-all font-mono">{client.configPath}</TooltipContent>
        </Tooltip>
        <Badge variant={client.installed ? "default" : "outline"}>{t(`mcp.status.${status}`)}</Badge>
      </div>
      <Button size="sm" variant={client.installed ? "outline" : "default"} disabled={busy} onClick={onToggle}>
        {busy && <Spinner className="size-3.5" />}
        {client.installed ? t("mcp.remove") : t("mcp.install")}
      </Button>
    </div>
  );
}
