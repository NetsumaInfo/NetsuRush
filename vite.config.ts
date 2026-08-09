import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Renderer de l'app standalone (coquille Tauri). base './' → le build prod (dist/) se charge en
// relatif, servi par Tauri (frontendDist).
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  base: "./",
  // La version vient de package.json (même source que tauri.conf.json) → jamais recopiée dans le
  // renderer, cf. src/lib/release.ts.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Les paquets `dictionary-*` n'exposent que `./index.js` dans leurs `exports` (un chargeur
      // Node qui lit les fichiers depuis le disque, inutilisable en navigateur). Le correcteur a
      // besoin des fichiers Hunspell EUX-MÊMES, importés en `?url` : on aliase donc le paquet sur
      // son dossier réel pour que les sous-chemins .aff/.dic se résolvent.
      "dictionary-fr": fileURLToPath(new URL("./node_modules/dictionary-fr", import.meta.url)),
      "dictionary-en": fileURLToPath(new URL("./node_modules/dictionary-en", import.meta.url)),
    },
  },
  // Le worker du correcteur est un module ES (import statique de nspell) : le format iife par
  // défaut de Rollup pour les workers ne sait pas le porter.
  worker: { format: "es" },
  // nspell est publié en CommonJS : sans pré-bundling, l'import dans le worker casse en dev.
  optimizeDeps: { include: ["nspell"] },
  server: {
    // Bind IPv4 EXPLICITE. Par défaut Vite écoute « localhost » qui, sous Windows, ne résout
    // souvent qu'en IPv6 ([::1]) → la WebView2 de Tauri tape 127.0.0.1 (IPv4) et reçoit un refus
    // de connexion = FENÊTRE BLANCHE. On force donc 127.0.0.1.
    // MAIS le devUrl de tauri.conf.json reste « http://localhost:1420 » (PAS l'IP) : la WebView2
    // résout localhost → 127.0.0.1 (où Vite écoute) et l'ORIGINE du document devient
    // http://localhost:1420. C'est REQUIS pour les embeds YouTube : l'IFrame Player REFUSE une
    // origine en IP nue (127.0.0.1) → « Vidéo non disponible » ; il accepte « localhost ».
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
});
