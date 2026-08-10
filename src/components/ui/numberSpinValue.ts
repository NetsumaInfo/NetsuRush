function decimalPlaces(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

export function clampSteppedNumber(value: number, min: number, max: number, step: number): number {
  const bounded = Math.min(max, Math.max(min, value));
  const safeStep = step > 0 ? step : 1;
  const precision = Math.max(decimalPlaces(min), decimalPlaces(max), decimalPlaces(safeStep));
  const snapped = min + Math.round((bounded - min) / safeStep) * safeStep;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(precision));
}
