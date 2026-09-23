// @ts-check
// Opens a terminal on a CLI agent's login command.
//
// These agents authenticate through a subscription: the command opens a browser,
// waits for the user to approve, and writes a token of its own. It is
// interactive by construction. Driving it headlessly would mean capturing a
// prompt we do not control and a browser handshake we cannot complete, so the
// button hands the user a terminal that is already on the right command instead
// of pretending to do it for them.

const { spawn } = require('child_process');
const { getDef } = require('./runtimes/defs');
const { t } = require('../i18n');

/// Quoted for `cmd /k`, which splits on spaces and would otherwise break any
/// path containing one — the normal case under Program Files.
function quote(part) {
  return /[\s&|<>^]/.test(part) ? `"${part}"` : part;
}

/**
 * Starts an agent's login in a visible terminal.
 * @param {{ id:string, bin?:string }} request
 */
function openAgentLogin(request) {
  const def = getDef(String(request.id || ''));
  if (!def) return { ok: false, error: t('agentUnknownAgent', { id: String(request.id) }) };
  if (!Array.isArray(def.loginArgs)) {
    return { ok: false, error: t('agentNoLoginCommand', { name: def.name }) };
  }

  // Le binaire résolu par la détection l'emporte : il peut être un chemin
  // complet hors PATH, et c'est précisément le cas que le PATH ne couvre pas.
  const binary = request.bin || def.bin;
  const command = [quote(binary), ...def.loginArgs].join(' ');

  try {
    if (process.platform === 'win32') {
      // `start` ouvre une nouvelle fenêtre ; `/k` la garde ouverte après la
      // commande, sinon le message de fin disparaît avant d'être lu.
      const child = spawn('cmd', ['/c', 'start', '""', 'cmd', '/k', command], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
    } else {
      const child = spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return { ok: true, command };
  } catch (e) {
    return { ok: false, error: String((e && /** @type {any} */(e).message) || e) };
  }
}

/// Lance l'installation d'un agent dans un terminal visible.
///
/// La commande vient de l'interface, qui la lit dans son catalogue : c'est du
/// texte que le renderer contrôle, jamais une saisie libre de l'utilisateur ni
/// quoi que ce soit qui vienne du réseau. Elle est tout de même bornée à un
/// petit ensemble de formes connues, parce qu'un canal qui exécute une chaîne
/// arbitraire est une porte ouverte, quelle que soit la confiance qu'on place
/// dans son appelant du jour.
///
/// `irm <url> | iex` a ete RETIRE de cette liste. Deux raisons, mesurees :
///
///   1. Defender le bloque. Telecharger un script et l'executer dans la foulee
///      est la forme canonique du dropper, et AMSI la reconnait comme telle.
///      Le motif est dangereux independamment de ce que contient le script du
///      jour, donc l'antivirus a raison ; contourner cette detection depuis un
///      produit qu'on vend serait exactement le mauvais geste.
///   2. L'URL n'est pas verifiable. Sondees le 2026-09-07 :
///      antigravity.google/cli/install.ps1 rend bien un script (7 Ko), mais
///      cursor.com/install.ps1 rend une page HTML de 162 Ko — cette
///      commande-la aurait envoye un site web entier dans un interpreteur.
///
/// Ces agents ouvrent donc leur page d'installation officielle, et
/// l'utilisateur installe lui-meme. Un paquet npm ou pip reste lance ici : il
/// est nomme, versionne, et resolu par un gestionnaire de paquets.
const INSTALL_SHAPES = [
  /^npm install -g @?[\w@./-]+$/,
  /^python -m pip install [\w.-]+$/,
];

/// Séparé de l'exécution pour être testable sans rien lancer — et parce que
/// « refusé par la politique » et « le terminal n'a pas démarré » sont deux
/// pannes différentes qu'un seul `ok:false` rendait indiscernables.
/** @param {string} command */
function installCommandAllowed(command) {
  return INSTALL_SHAPES.some((shape) => shape.test(command));
}

/** @param {{ command?:string }} request */
function openAgentInstall(request) {
  const command = String(request.command || '').trim();
  if (!installCommandAllowed(command)) {
    return { ok: false, reason: 'refused', error: t('agentInstallRefused', { command }) };
  }
  try {
    if (process.platform === 'win32') {
      // PowerShell plutôt que cmd : les installeurs en une ligne des projets
      // sont écrits pour lui (`irm … | iex`), et npm y marche aussi.
      const child = spawn(
        'cmd',
        ['/c', 'start', '""', 'powershell', '-NoExit', '-Command', command],
        { detached: true, stdio: 'ignore', windowsHide: false },
      );
      child.unref();
    } else {
      const child = spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return { ok: true, command };
  } catch (e) {
    return { ok: false, reason: 'spawn', error: String((e && /** @type {any} */(e).message) || e) };
  }
}

module.exports = { openAgentLogin, openAgentInstall, installCommandAllowed };
