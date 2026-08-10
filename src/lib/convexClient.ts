import { ConvexReactClient } from "convex/react";

// URL du déploiement Convex (*.convex.cloud). Absente tant que `npx convex dev` n'a pas tourné :
// le client reste null → l'app boot exactement comme avant (dev/navigateur/mock, zéro régression).
const url = import.meta.env.VITE_CONVEX_URL as string | undefined;

export const convexClient = url ? new ConvexReactClient(url) : null;
