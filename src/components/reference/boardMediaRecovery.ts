export type RecoverableOnlineItem = {
  id: string;
  kind?: string;
  ref?: string;
  frames?: string[];
  sourceUrl?: string;
  prevMedia?: { sourceUrl?: string };
  missing?: unknown;
};

export function originalOnlineSource(item: RecoverableOnlineItem): string {
  return item.sourceUrl || item.prevMedia?.sourceUrl || "";
}

export function recoverableOnlineItems<T extends RecoverableOnlineItem>(items: T[]): T[] {
  return items.filter((item) => {
    const source = originalOnlineSource(item);
    if (!/^https?:/i.test(source)) return false;
    if (item.kind === "sequence") return !!item.missing || !(item.frames || []).some(Boolean);
    return (item.kind === "image" || item.kind === "video") && (!!item.missing || !item.ref);
  });
}

export async function runSequentialRecovery<T>(
  items: T[],
  recover: (item: T) => Promise<boolean>,
  onProgress?: (current: number, total: number) => void,
) {
  let recovered = 0;
  for (let index = 0; index < items.length; index += 1) {
    onProgress?.(index + 1, items.length);
    if (await recover(items[index])) recovered += 1;
  }
  return { total: items.length, recovered, failed: items.length - recovered };
}
