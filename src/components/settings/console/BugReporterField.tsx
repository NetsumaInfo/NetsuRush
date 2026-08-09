import { useEffect } from "react";
import { UserRound } from "lucide-react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/lib/convexApi";
import { convexConfigured } from "@/lib/convexEnv";
import { Input } from "@/components/ui/input";
import { useDiscordProfile } from "../useDiscordProfile";
import { useTranslation } from "react-i18next";

export type ReporterIdentity = { discordId: string | null; discordName: string | null; text: string | null };

type Props = {
  manual: string;
  onManualChange: (value: string) => void;
  onIdentity: (identity: ReporterIdentity) => void;
};

// Connecté, l'identité vient du compte (id + pseudo) : un pseudo tapé à la main ne permet pas de
// relancer l'auteur. La saisie libre sert de repli.
export function BugReporterField(props: Props) {
  if (!convexConfigured) return <ManualReporter {...props} />;
  return <ConnectedReporter {...props} />;
}

function ManualReporter({ manual, onManualChange, onIdentity }: Props) {
  const { t } = useTranslation("settings");
  useEffect(() => {
    onIdentity({ discordId: null, discordName: null, text: manual.trim() || null });
  }, [manual, onIdentity]);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="bug-discord" className="text-xs text-muted-foreground">{t("bugReport.discord")}</label>
      <Input id="bug-discord" value={manual} onChange={(e) => onManualChange(e.target.value)} placeholder={t("bugReport.discordPlaceholder")} />
    </div>
  );
}

function ConnectedReporter(props: Props) {
  const { t } = useTranslation("settings");
  const { isAuthenticated } = useConvexAuth();
  const user = useQuery(api.auth.getCurrentUser) as { name?: string | null; image?: string | null } | null | undefined;
  const profile = useDiscordProfile();
  const { onIdentity } = props;

  const name = profile?.username ?? user?.name ?? null;
  const id = profile?.id ?? null;
  const linked = isAuthenticated && !!name;

  useEffect(() => {
    if (linked) onIdentity({ discordId: id, discordName: name, text: null });
  }, [linked, id, name, onIdentity]);

  if (!linked) return <ManualReporter {...props} />;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{t("bugReport.discord")}</span>
      <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5">
        {user?.image ? (
          <img src={user.image} alt="" className="size-5 rounded-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <UserRound className="size-4 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{name}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{t("bugReport.auto")}</span>
      </div>
    </div>
  );
}
