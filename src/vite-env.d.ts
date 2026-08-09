/// <reference types="vite/client" />

// Extension chimie de KaTeX (\ce{H2O}) : le paquet livre le .mjs sans typage. Elle patche
// l'instance KaTeX par effet de bord et n'expose rien — un module vide est la déclaration exacte.
declare module "katex/contrib/mhchem";

// Version de package.json injectée au build (vite `define`) — cf. src/lib/release.ts.
declare const __APP_VERSION__: string;
