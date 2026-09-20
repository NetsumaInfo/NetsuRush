// @ts-check
// Détection des agents CLI. Résultat consommé par l'UI (réglages, sélecteur de moteur) et par la
// session (choisir un agent disponible). Best-effort, jamais bloquant.
//
// Le PATH ne suffit pas, et « absent » tout court induisait en erreur. Antigravity s'installe comme
// une application (`Antigravity.exe`) et sa commande `agy` est un shim séparé que l'utilisateur doit
// ajouter depuis l'app — exactement le modèle de `code` pour VS Code. Un utilisateur qui a
// l'application et lit « absent » conclut que la détection est cassée, et il a raison de le penser :
// la réponse était vraie mais inutilisable. On distingue donc trois états.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { listDefs } = require('./defs');

const PROBE_TIMEOUT_MS = 4000;

/// Dossiers d'installation à sonder en plus du PATH, par agent.
///
/// Un binaire installé mais hors PATH est indétectable autrement, et c'est la
/// situation par défaut de tout ce qui s'installe en application plutôt qu'en
/// paquet npm global.
function extraBinDirs() {
  const local = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return {
    // npm -g : le cas le plus courant sur Windows, et il n'est PAS toujours
    // dans le PATH du process qui nous lance (services, shells non interactifs).
    // `~/.local/bin` : là où atterrissent les installeurs en une ligne (script
    // shell / PowerShell), qui n'ajoutent pas toujours le dossier au PATH.
    common: [
      appData && path.join(appData, 'npm'),
      home && path.join(home, '.local', 'bin'),
    ].filter(Boolean),
    cursor: [local && path.join(local, 'Programs', 'cursor', 'resources', 'app', 'bin')].filter(Boolean),
    // L'installeur documenté dépose `agy` ici, PAS dans le dossier de
    // l'application : chercher à côté de l'IDE ne le trouve jamais.
    antigravity: [
      local && path.join(local, 'agy', 'bin'),
      local && path.join(local, 'Antigravity'),
      local && path.join(local, 'Programs', 'Antigravity', 'bin'),
    ].filter(Boolean),
  };
}

/// Marqueurs prouvant que l'application est installée, même sans sa commande.
/// C'est ce qui permet de dire « l'app est là, la commande manque » plutôt que
/// « absent », qui est vrai et n'aide personne.
function appMarkers() {
  const local = process.env.LOCALAPPDATA || '';
  return {
    antigravity: [local && path.join(local, 'Programs', 'Antigravity', 'Antigravity.exe')].filter(Boolean),
    cursor: [local && path.join(local, 'Programs', 'cursor', 'Cursor.exe')].filter(Boolean),
  };
}

/** @param {string} bin @param {string[]} args @param {string} [cwd] */
function probe(bin, args, cwd) {
  return new Promise((resolve) => {
    // shell:true → résout claude.cmd / codex.cmd sur Windows (bins npm) sans extension explicite.
    const child = execFile(
      bin, args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, shell: true, ...(cwd ? { cwd } : {}) },
      (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout || '').trim().split('\n')[0] || 'ok');
      },
    );
    child.on('error', () => resolve(null));
  });
}

/// Cherche le binaire dans un dossier donné, en essayant les extensions
/// exécutables de Windows.
function findIn(dir, bin) {
  for (const suffix of ['', '.cmd', '.exe', '.bat', '.ps1']) {
    const candidate = path.join(dir, bin + suffix);
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* dossier illisible */ }
  }
  return null;
}

// Sonde un agent : PATH d'abord, puis les dossiers d'installation connus, puis
// le marqueur d'application. Renvoie {id, name, available, version, bin, state}.
/** @param {import('./types').RuntimeAgentDef} def */
async function detectOne(def) {
  const names = [def.bin, ...(def.fallbackBins || [])];
  // `modelsFrom` voyage avec l'agent : c'est ce qui permet a l'UI de demander
  // la liste vivante du bon fournisseur sans re-deriver la correspondance.
  const base = {
    id: def.id, name: def.name,
    models: def.models || [],
    modelsFrom: def.modelsFrom || null,
  };

  for (const bin of names) {
    const version = await probe(bin, def.versionArgs);
    if (version != null) return { ...base, available: true, version, bin, state: 'ready' };
  }

  const dirs = extraBinDirs();
  const search = [...(dirs.common || []), ...(dirs[def.id] || [])];
  for (const dir of search) {
    for (const bin of names) {
      const found = findIn(dir, bin);
      if (!found) continue;
      const version = await probe(`"${found}"`, def.versionArgs);
      // Le chemin complet est renvoyé : c'est lui qu'il faut lancer, le PATH ne
      // le résoudra pas.
      if (version != null) return { ...base, available: true, version, bin: found, state: 'ready' };
    }
  }

  const markers = appMarkers()[def.id] || [];
  for (const marker of markers) {
    try {
      if (!fs.existsSync(marker)) continue;
      return {
        ...base,
        available: false,
        version: null,
        bin: def.bin,
        // L'application est là, la commande non. Deux problèmes différents,
        // deux réparations différentes.
        state: 'app-without-cli',
        appPath: marker,
      };
    } catch { /* chemin illisible */ }
  }

  return { ...base, available: false, version: null, bin: def.bin, state: 'missing' };
}

// Sonde tous les agents en parallèle.
async function detectAgents() {
  return Promise.all(listDefs().map(detectOne));
}

module.exports = { detectAgents, detectOne };
