import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "@/lib/authClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function message(error: unknown, fallback: string) {
  const e = error as { message?: string } | null;
  return e?.message || fallback;
}

/**
 * Sign-in by e-mail: the address, then the 6-digit code the deployment sends to it. The first code
 * creates the account; the session lands reactively, like the Discord return.
 */
export function EmailLogin({ size }: { size?: "sm" }) {
  const { t } = useTranslation("auth");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setError(null);
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError(t("login.offlineNeedsNet"));
      return;
    }
    setBusy(true);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" });
      if (res.error) setError(message(res.error, t("email.sendFailed")));
      else setSent(true);
    } catch (e) {
      setError(message(e, t("email.sendFailed")));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() });
      if (res.error) setError(message(res.error, t("email.wrongCode")));
    } catch (e) {
      setError(message(e, t("email.wrongCode")));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void (sent ? verify() : sendCode());
  };

  return (
    <form onSubmit={submit} className="w-full space-y-2 text-left">
      {!sent ? (
        <Input
          type="email"
          autoComplete="email"
          placeholder={t("email.address")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("email.codeSent", { email: email.trim() })}</p>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder={t("email.code")}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            disabled={busy}
            autoFocus
          />
        </>
      )}
      {error && <p className="break-words text-xs text-destructive">{error}</p>}
      <Button
        type="submit"
        size={size}
        variant="outline"
        className="w-full"
        disabled={busy || (sent ? code.trim().length !== 6 : !EMAIL.test(email.trim()))}
      >
        {sent ? t("email.signIn") : t("email.sendCode")}
      </Button>
      {sent && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline hover:text-foreground"
          onClick={() => {
            setSent(false);
            setCode("");
            setError(null);
          }}
        >
          {t("email.changeAddress")}
        </button>
      )}
    </form>
  );
}
