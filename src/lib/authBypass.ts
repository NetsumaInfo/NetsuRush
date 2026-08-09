const AUTH_BYPASS_KEY = "nr.auth.skipped";

export function authWasSkipped(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(AUTH_BYPASS_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistAuthSkip(): void {
  try {
    localStorage.setItem(AUTH_BYPASS_KEY, "1");
  } catch {
    /* best-effort */
  }
}
