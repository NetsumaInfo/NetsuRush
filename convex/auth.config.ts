import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

// Provider JWT lu par Convex pour valider le `convex_jwt` émis par Better Auth.
// L'issuer/applicationID sont déduits de CONVEX_SITE_URL (auto-défini sur le déploiement).
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig;
