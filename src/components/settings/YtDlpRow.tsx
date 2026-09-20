// Settings › Updates — the yt-dlp row, inside the updater card.
// yt-dlp is the only runtime dependency that rots: platforms break its extractors every few weeks,
// while ffmpeg, the shaders and the weights keep working for years. The core refreshes it once per
// application release (core/ytdlpUpdate.js), which leaves one hole — an installation nobody updates
// for months stops refreshing the very thing that ages fastest. This row is that second door.
// It is a ROW, not a card: one line of state and one button, like the two toggles above it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Info, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { nr, type YtDlpStatus } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function YtDlpRow() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<YtDlpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Only what the refreshed status cannot say on its own: an update that failed, and the one moment
  // where a version really moved. "Already current" needs no line — the state line already says it.
  const [outcome, setOutcome] = useState<{ failed: boolean; detail: string } | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await nr.ytDlpStatus();
      if (alive.current) setStatus(next);
    } catch (_) {
      // A core that cannot answer falls through to the "not installed" line: nothing the user did
      // failed here, so it is not worth an error of its own.
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [load]);

  const update = useCallback(async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const result = await nr.ytDlpUpdate();
      if (!alive.current) return;
      setOutcome(result.ok
        ? (result.changed ? { failed: false, detail: result.version || "" } : null)
        : { failed: true, detail: result.error || "" });
      await load();
    } catch (error) {
      if (alive.current) setOutcome({ failed: true, detail: String((error as Error)?.message || error) });
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [load]);

  // A yt-dlp this product did not provision is reported, never replaced (cf. core/ytdlpUpdate.js).
  const updatable = Boolean(status?.owned);
  // The button only exists when it has something to do: an update is published, or the probe could
  // not reach the registry and clicking is then the only way to find out. A library already current
  // offers no button at all — the state line is the whole answer.
  const actionable = updatable && Boolean(status?.available) && (status?.outdated || status?.latest == null);
  const line = outcome?.failed
    ? `${t("updates.ytdlp.failed")}${outcome.detail ? ` — ${outcome.detail}` : ""}`
    : loading ? t("updates.ytdlp.checking")
    : !status?.available ? t("updates.ytdlp.missing")
    : outcome ? t("updates.ytdlp.updated", { version: outcome.detail })
    : !updatable ? t("updates.ytdlp.notOwned", { version: status.version })
    : status.outdated ? t("updates.ytdlp.available", { version: status.version, latest: status.latest })
    // Nothing came back from the registry: showing "up to date" would be a claim we cannot make.
    : status.latest == null ? t("updates.ytdlp.unknown", { version: status.version })
    : t("updates.ytdlp.current", { version: status.version });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          yt-dlp
          <Tooltip>
            <TooltipTrigger
              render={<button type="button" className="text-muted-foreground transition-colors hover:text-foreground" aria-label={t("updates.ytdlp.hint")} />}
            >
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{t("updates.ytdlp.hint")}</TooltipContent>
          </Tooltip>
        </p>
        <p className={outcome?.failed ? "mt-1 break-words text-xs text-destructive" : "mt-1 text-xs text-muted-foreground"}>{line}</p>
      </div>
      {(actionable || busy) && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void update()}>
          <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} /> {busy ? t("updates.ytdlp.updating") : t("updates.ytdlp.update")}
        </Button>
      )}
    </div>
  );
}
