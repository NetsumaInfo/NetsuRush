// @ts-check
// Noms d'images (exécutables) des LOGICIELS DE MONTAGE pilotés par NetsuRush — SOURCE UNIQUE.
//
// Pourquoi ce module : trois endroits connaissaient ces noms séparément (`hostPower.js` pour
// fermer/rouvrir un hôte, `adobe.js` pour savoir si Premiere/AE tourne, `optimize.js` pour interdire
// de les tuer) et la troisième copie était INCOMPLÈTE — la liste des processus protégés du
// gestionnaire de ressources ne contenait que Resolve. Sur un poste Premiere/After Effects, la
// fenêtre « tuer ce processus » proposait donc l'hôte qui tient le montage en cours.
//
// Les SATELLITES comptent autant que les hôtes eux-mêmes : tuer le serveur Dynamic Link ou le moteur
// CEP fait tomber la session Adobe (et notre propre panneau) sans que le nom « Premiere » apparaisse
// nulle part. Le pilote graphique est dans le même sac : `nvcontainer` mort = plus d'encodage NVENC.

/** Exécutable principal de chaque hôte, par identifiant d'hôte (`activeHost` côté renderer). */
const HOST_IMAGES = {
  resolve: "Resolve.exe",
  ppro: "Adobe Premiere Pro.exe",
  aeft: "AfterFX.exe",
};

/**
 * Processus qui portent une session de montage sans en porter le nom : moteurs de liaison Adobe,
 * hôte des extensions CEP (= notre panneau), scripting Fusion, encodeur de file d'attente.
 */
const HOST_SATELLITE_IMAGES = [
  "dynamiclinkmanager.exe", // serveur Dynamic Link : sa mort casse le lien Premiere ⇄ AE
  "Adobe QT32 Server.exe", // décodeur QuickTime 32 bits de Premiere
  "Adobe Media Encoder.exe", // peut porter un rendu en cours
  "AdobeIPCBroker.exe", // licence + IPC Creative Cloud
  "CEPHtmlEngine.exe", // moteur des panneaux CEP — dont le panneau NetsuRush
  "fuscript.exe",
  "fusionscript.exe",
];

/**
 * Services du pilote graphique : les tuer coupe l'affichage ou l'encodeur matériel. Ce ne sont PAS
 * des processus Windows au sens strict, d'où leur place ici plutôt que dans la liste système.
 */
const GPU_DRIVER_IMAGES = ["nvcontainer.exe", "NVDisplay.Container.exe", "amdow.exe", "atieclxx.exe"];

/** Nom d'image sans extension, en minuscules — la forme comparable partout dans le core. */
function imageBase(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\.exe$/i, "");
}

/** Toutes les images à ne jamais arrêter au titre du montage, en base minuscule. */
function protectedHostBases() {
  return new Set(
    [...Object.values(HOST_IMAGES), ...HOST_SATELLITE_IMAGES, ...GPU_DRIVER_IMAGES].map(imageBase),
  );
}

module.exports = {
  HOST_IMAGES,
  HOST_SATELLITE_IMAGES,
  GPU_DRIVER_IMAGES,
  imageBase,
  protectedHostBases,
};
