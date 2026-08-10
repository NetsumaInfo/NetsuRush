export const BLACK_PAUSE_MAX_SECONDS = 10;
export const BLACK_PAUSE_STEP_SECONDS = 0.1;

export function millisecondsToSeconds(milliseconds: number): number {
  return milliseconds / 1000;
}

export function secondsToMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000);
}
