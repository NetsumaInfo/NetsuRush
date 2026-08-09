import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";

// Monte le composant Better Auth (tables isolées : user/session/account/verification).
// L'auth vit DANS Convex → le secret Discord reste côté déploiement, jamais dans le bundle Tauri.
const app = defineApp();
app.use(betterAuth);

export default app;
