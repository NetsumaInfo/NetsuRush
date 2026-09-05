type GrantedPath = { path: string; grant: string };

const grants = new Map<string, string[]>();

function key(path: string): string {
  return path.replace(/\//g, "\\").toLocaleLowerCase();
}

export function rememberImportGrants(entries: GrantedPath[]): void {
  for (const entry of entries) {
    if (!entry.path || !/^[0-9a-f]{64}$/.test(entry.grant)) continue;
    const pathKey = key(entry.path);
    const existing = grants.get(pathKey) ?? [];
    existing.push(entry.grant);
    grants.set(pathKey, existing);
  }
}

export function takeImportGrant(path: string): string | null {
  const pathKey = key(path);
  const existing = grants.get(pathKey);
  const grant = existing?.shift() ?? null;
  if (!existing?.length) grants.delete(pathKey);
  return grant;
}
