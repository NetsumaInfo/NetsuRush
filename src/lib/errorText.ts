// A caught error as a sentence for the screen. `String(e)` put "Error: ENOENT: no such file…" or
// "TypeError: Cannot read properties of undefined" in front of the user, in English, whatever the
// interface language. The common system causes get a translated sentence that says what to do;
// the raw error always goes to the app console, where a bug report picks it up.
import i18n from "@/i18n";
import { describeError, logError } from "@/lib/appLog";

const CAUSES: [RegExp, string][] = [
  [/ECONNREFUSED|ECONNRESET|Failed to fetch|fetch failed|NetworkError|Load failed/i, "common:error.coreUnreachable"],
  [/ENOSPC|no space left/i, "common:error.diskFull"],
  [/ENOENT|no such file|cannot find the (file|path)/i, "common:error.notFound"],
  [/EACCES|EPERM|permission denied|operation not permitted|access is denied/i, "common:error.permission"],
  [/EBUSY|resource busy|being used by another process/i, "common:error.busy"],
  [/ETIMEDOUT|timed out|timeout/i, "common:error.timeout"],
];

// A programming error, not something the user caused or can fix by hand.
const BUG = /^(TypeError|ReferenceError|SyntaxError|RangeError|InternalError)\b|Cannot read propert|is not a function|is not defined|undefined is not|null is not/;

function rawMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

export function errorText(e: unknown, source = "ui"): string {
  const name = e instanceof Error ? e.name : "";
  const raw = rawMessage(e);
  // First line only, without the "Error: " a stringified Error starts with.
  const message = raw.split("\n")[0].replace(/^(Uncaught\s+)?(\w*Error|Exception):\s*/, "").trim();
  const cause = CAUSES.find(([re]) => re.test(message))?.[1];
  const shown = cause
    ? i18n.t(cause)
    : BUG.test(`${name}: ${message}`) || !message
      ? i18n.t("common:error.internal")
      : message;
  // Whatever was left off the screen (a cause, a stack, a prefix) stays readable in the console.
  if (shown !== raw) logError(source, describeError(e));
  return shown;
}
