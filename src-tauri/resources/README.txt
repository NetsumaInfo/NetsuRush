Ressources bundlées de NetsuRush (générées au build).

scripts/build.ps1 stage ici, AVANT `tauri build` :
  bin/node.exe        node portable (sidecar du core, fetch-node.ps1)
  core/               service Node "core" (copie de ../../core)
  python/             scripts sidecars ML (copie de ../../python)
  scripts/setup.ps1   provisionnement du 1er lancement

Ne pas committer le contenu stalegé (bin/core/python/scripts) — voir .gitignore.
Ce fichier sert d'ancre pour que le glob `resources/**/*` de tauri.conf.json matche en dev.
