import { createAuthClient } from "better-auth/react";
import {
  convexClient as convexAuthPlugin,
  crossDomainClient,
} from "@convex-dev/better-auth/client/plugins";

// Base = site Convex (*.convex.site) qui héberge les routes Better Auth.
const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;

// crossDomainClient : la webview desktop n'est pas sur le domaine Convex → le jeton de session
// transite hors cookie (stocké via localStorage, préfixe "netsurush"). convexAuthPlugin : lie la
// session Better Auth au JWT que Convex valide.
export const authClient = createAuthClient({
  baseURL: siteUrl ?? "http://localhost",
  plugins: [convexAuthPlugin(), crossDomainClient({ storagePrefix: "netsurush" })],
});
