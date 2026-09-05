import { configureAuth } from "./client";

/** Refreshes the short-lived Convex JWT in native memory; it is never written by Rust. */
export async function refreshNativeCollaborationAuth(deviceLabel?: string): Promise<boolean> {
  const deploymentUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!deploymentUrl) return false;
  const { authClient } = await import("@/lib/authClient");
  const result = await authClient.convex.token({ fetchOptions: { throw: false } });
  const token = result.data?.token;
  if (!token) return false;
  await configureAuth(deploymentUrl, token, deviceLabel);
  return true;
}
