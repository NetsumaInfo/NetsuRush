// The last calls an external agent made, newest first.
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { McpActivity } from "@/lib/bridge";

function ActivityRow({ activity }: { activity: McpActivity }) {
  const { t } = useTranslation("settings");
  const label = activity.action ? `${activity.name}.${activity.action}` : activity.name;
  const outcome = activity.ok ? t("mcp.ok") : t("mcp.failed");
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground tabular-nums">{new Date(activity.at).toLocaleTimeString()}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      <Badge variant="outline">{t(`mcp.risk.${activity.risk}`)}</Badge>
      {activity.ok || !activity.error ? (
        <span className={activity.ok ? "text-[var(--color-ok)]" : "text-destructive"}>{outcome}</span>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="text-destructive" />}>{outcome}</TooltipTrigger>
          <TooltipContent className="max-w-80">{activity.error}</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

export function McpRecentActivity({ recent }: { recent: McpActivity[] }) {
  const { t } = useTranslation("settings");
  if (recent.length === 0) {
    return <p className="rounded-lg border border-border px-4 py-3 text-xs text-muted-foreground">{t("mcp.recentEmpty")}</p>;
  }
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {recent.map((activity, index) => <ActivityRow key={`${activity.at}-${index}`} activity={activity} />)}
    </ul>
  );
}
