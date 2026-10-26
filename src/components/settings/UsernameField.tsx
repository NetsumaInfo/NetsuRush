import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery } from "convex/react";
import { Pencil } from "lucide-react";
import { api } from "@/lib/convexApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uiLocale } from "@/lib/utils";

type Result =
  | { status: "ok"; username: string }
  | { status: "cooldown"; nextChangeAt: number }
  | { status: "format" | "reserved" | "taken" | "noProfile" };

type Self = { username?: string | null; discordUsername?: string | null } | null;

/**
 * The pseudonym friends type to add this account, shown with an edit button. A Discord account
 * starts with its Discord username here; saving a new one replaces it.
 */
export function UsernameField() {
  const { t } = useTranslation("collab");
  const social = useQuery(api.social.listSocial) as { self: Self } | undefined;
  const setUsername = useMutation(api.social.setUsername);
  const current = social?.self?.username ?? social?.self?.discordUsername ?? null;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const startEdit = () => {
    setValue(current ?? "");
    setMessage(null);
    setEditing(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = (await setUsername({ username: value })) as Result;
      if (res.status === "ok") {
        setEditing(false);
        setMessage({ text: t("username.saved"), error: false });
      } else if (res.status === "cooldown")
        setMessage({
          text: t("username.cooldown", { date: new Date(res.nextChangeAt).toLocaleDateString(uiLocale()) }),
          error: true,
        });
      else setMessage({ text: t(`username.${res.status}`), error: true });
    } catch {
      setMessage({ text: t("username.error"), error: true });
    } finally {
      setBusy(false);
    }
  };

  if (!social?.self) return null;
  const normalized = value.trim().replace(/^@/, "").toLowerCase();

  return (
    <div className="mt-3 space-y-1.5 border-t border-border pt-3">
      <p className="text-xs font-medium">{t("username.label")}</p>
      {editing ? (
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("username.placeholder")}
            maxLength={21}
            className="h-8"
            disabled={busy}
            autoFocus
          />
          <Button type="submit" size="sm" disabled={busy || !normalized || normalized === current}>
            {t("username.save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            {t("username.cancel")}
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm">
            {current ? `@${current}` : <span className="text-muted-foreground">{t("username.none")}</span>}
          </p>
          <Button size="sm" variant="outline" onClick={startEdit}>
            <Pencil className="size-3.5" /> {t("username.edit")}
          </Button>
        </div>
      )}
      {editing && <p className="text-xs text-muted-foreground">{t("username.hint")}</p>}
      {message && (
        <p className={message.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{message.text}</p>
      )}
    </div>
  );
}
