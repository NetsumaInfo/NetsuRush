// A collaboration failure as a sentence for the screen.
import i18n from "@/i18n";
import { describeError, logError } from "@/lib/appLog";
import { errorText } from "@/lib/errorText";
import { collabErrorMessage } from "./client";
import { collabFailureKey } from "./failure";
import type { UnresolvedMedia } from "./session";

/**
 * A coded failure gets its translated sentence, anything else goes through `errorText` like the
 * rest of the app, and a rejection that carries no message at all shows `fallback`.
 */
export function collabErrorText(error: unknown, fallback = i18n.t("collab:error.failed")): string {
  const key = collabFailureKey(error);
  if (key) {
    logError("collab", describeError(error));
    return i18n.t(key);
  }
  // A Convex error keeps its text in `data`, a Tauri rejection is a plain object: read all shapes.
  const message = collabErrorMessage(error, "");
  if (!message) return fallback;
  return errorText(error instanceof Error ? error : message, "collab");
}

/** The first few file names of media that could not travel, without their folders. */
export function unresolvedNames(missing: UnresolvedMedia[]): string {
  return missing
    .slice(0, 3)
    .map((entry) => entry.ref.split(/[\\/]/).pop() || entry.ref)
    .join(" · ");
}
