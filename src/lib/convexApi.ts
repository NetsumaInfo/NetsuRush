import { anyApi } from "convex/server";

// API Convex NON typée : les types générés (`convex/_generated/api`) n'existent qu'après
// `npx convex dev`. anyApi garde `npm run build` vert AVANT provisioning et référence les
// fonctions par chemin (ex. `api.access.getAccess`, `api.auth.getCurrentUser`).
export const api = anyApi;
