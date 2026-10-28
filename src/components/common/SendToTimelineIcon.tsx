import { NetsuIcon } from "@/components/ui/netsu-icon";
import { useApp } from "@/store";
import type { TimelineHost } from "@/features/timeline/insertion";

/** The icon names its variants with dashes (`ripple-overwrite`), the store with underscores. */
export function SendToTimelineIcon({ host, busy, className }: { host?: TimelineHost; busy?: boolean; className?: string }) {
  const activeHost = useApp((state) => state.activeHost);
  const mode = useApp((state) => state.timelineInsertions[host ?? activeHost]);
  return <NetsuIcon name="cut-send-timeline" mode={mode.replace("_", "-")} busy={busy} className={className} />;
}
