// Canal de publication de l'app. SOURCE UNIQUE du badge « BETA » (barre de titre, écran de
// connexion, panneau CEP, À propos) : passer à "stable" fait disparaître le badge partout d'un
// seul coup, sans chasser les libellés dans les composants.
export type ReleaseChannel = "beta" | "stable";

export const RELEASE_CHANNEL: ReleaseChannel = "beta";

export const IS_PRERELEASE = RELEASE_CHANNEL === "beta";

// Volontairement SANS accent et non traduit : « beta » se lit tel quel dans les 6 langues de
// l'app, une clé i18n par locale n'apporterait rien (le rendu est en capitales via CSS).
export const CHANNEL_LABEL = "beta";

// Injectée par vite (define) depuis package.json → une seule version à faire évoluer.
export const APP_VERSION = __APP_VERSION__;

export const VERSION_LABEL = IS_PRERELEASE ? `v${APP_VERSION} ${CHANNEL_LABEL}` : `v${APP_VERSION}`;
