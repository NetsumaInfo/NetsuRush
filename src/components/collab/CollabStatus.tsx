// Status pill of a shared document: who is there, and what is still owed.
//
// The presence shown is what THIS machine has OBSERVED — the last time it successfully reached one
// of that person's devices (`service.rs#member_presence`). Nothing is broadcast for it and no extra
// traffic is created; those exchanges happen anyway. Hence "last seen…" rather than "offline": a
// person this machine has not reached is not necessarily away, they may simply be unreachable from
// here. Claiming more would be a lie.
//
// Mount it only on a shared document, behind a lazy import: the convex/react chain must not enter
// the startup bundle (see `src/lib/convexEnv.ts`).

import { useTranslation } from "react-i18next";
import { useQuery } from "convex/react";
import { AlertTriangle, Check, RefreshCw, UserRound, Users } from "lucide-react";
import { api } from "@/lib/convexApi";
import { cn } from "@/lib/utils";
import type { MemberPresence } from "@/lib/collab/client";
import type { ProjectRole } from "@/lib/collab/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Profile = { userId: string; handle: string; name: string; image: string | null };
type Details = {
  members: Array<Profile & { role: ProjectRole }>;
  pending: Array<Profile & { inviteId: string }>;
} | null | undefined;

// Past this, "online" is no longer said: the last exchange is too old to assert it.
const ONLINE_MS = 90_000;

function Avatar({ url, online }: { url: string | null; online: boolean }) {
  return (
    <span className="relative shrink-0">
      {url ? (
        <img src={url} alt="" className="size-6 rounded-full object-cover" referrerPolicy="no-referrer" />
      ) : (
        <span className="flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <UserRound className="size-3.5" />
        </span>
      )}
      <span
        className={cn(
          "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-popover",
          online ? "bg-[var(--color-ok)]" : "bg-muted-foreground/40",
        )}
      />
    </span>
  );
}

export function CollabStatus({
  projectId,
  role,
  members,
  offlineQueued,
  rotationRequired,
}: {
  projectId: string | null;
  role: ProjectRole | null;
  members: MemberPresence[];
  offlineQueued: boolean;
  rotationRequired: boolean;
}) {
  const { t } = useTranslation("collab");
  const details = useQuery(
    api.projects.getProjectDetails,
    projectId ? { projectId, now: 0 } : "skip",
  ) as Details;

  if (!projectId) return null;

  const profiles = new Map((details?.members ?? []).map((member) => [member.userId, member]));
  const seen = members.map((member) => ({
    ...member,
    profile: profiles.get(member.userId),
    online: member.lastSeenMs != null && member.lastSeenMs < ONLINE_MS,
  }));
  const onlineCount = seen.filter((member) => member.online).length;
  // A stable, useful order: the people who are here first, then the most recently seen.
  seen.sort((left, right) =>
    Number(right.online) - Number(left.online)
    || (left.lastSeenMs ?? Infinity) - (right.lastSeenMs ?? Infinity));
  const waitingForKey = seen.filter((member) => !member.hasKey);
  const pending = details?.pending ?? [];

  const ago = (ms?: number | null) => {
    if (ms == null) return t("panel.neverSeen");
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return t("panel.seenMinutes", { count: Math.max(1, minutes) });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("panel.seenHours", { count: hours });
    return t("panel.seenDays", { count: Math.floor(hours / 24) });
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={t("panel.title")}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                />
              }
            />
          }
        >
          <Users className="size-3.5" />
          <span className={onlineCount ? "text-[var(--color-ok)]" : undefined}>{onlineCount}</span>
          {(offlineQueued || rotationRequired) && (
            <span className="size-1.5 rounded-full bg-amber-500" />
          )}
        </TooltipTrigger>
        <TooltipContent>{t("panel.title")}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-border px-3 py-2">
          <p className="text-sm font-medium">{t("panel.title")}</p>
          <p className="text-xs text-muted-foreground">
            {t(`projects.role.${role ?? "editor"}`)}
            {" · "}
            {t("panel.online", { count: onlineCount })}
          </p>
        </div>

        <div className="max-h-56 divide-y divide-border overflow-y-auto px-3">
          {seen.length === 0 && (
            <p className="py-3 text-xs text-muted-foreground">{t("panel.alone")}</p>
          )}
          {seen.map((member) => (
            <div key={member.userId} className="flex items-center gap-2.5 py-2">
              <Avatar url={member.profile?.image ?? null} online={member.online} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs">
                  {member.profile?.name || member.profile?.handle || t("panel.unknownMember")}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {member.online ? t("panel.hereNow") : ago(member.lastSeenMs)}
                  {!member.canWrite ? ` · ${t("projects.role.viewer")}` : ""}
                </p>
              </div>
            </div>
          ))}
          {pending.map((invited) => (
            <div key={invited.inviteId} className="flex items-center gap-2.5 py-2 opacity-60">
              <Avatar url={invited.image} online={false} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs">{invited.name || invited.handle}</p>
                <p className="truncate text-[10px] text-muted-foreground">{t("panel.invited")}</p>
              </div>
            </div>
          ))}
        </div>

        {/* What is still owed, and by WHOM: a wait nobody can clear is not information, it is
            worry. */}
        <div className="space-y-1.5 border-t border-border px-3 py-2 text-xs">
          {/* "Everything is in sync" only holds if someone could actually have received: with
              nobody reachable the work is waiting here, whatever the local outbox says. Saying
              otherwise let the user believe the others already had their edits. */}
          {offlineQueued ? (
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <RefreshCw className="mt-0.5 size-3.5 shrink-0" />
              {t("panel.queued")}
            </p>
          ) : seen.length > 0 && onlineCount === 0 ? (
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <RefreshCw className="mt-0.5 size-3.5 shrink-0" />
              {t("panel.nobodyReachable")}
            </p>
          ) : (
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--color-ok)]" />
              {t("panel.upToDate")}
            </p>
          )}
          {rotationRequired && (
            <p className="flex items-start gap-1.5 text-amber-500">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t("panel.rotation")}
            </p>
          )}
          {waitingForKey.length > 0 && (
            <p className="flex items-start gap-1.5 text-amber-500">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t("panel.waitingKey", { count: waitingForKey.length })}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
