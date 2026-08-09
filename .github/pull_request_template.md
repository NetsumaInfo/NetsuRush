## Ce qui change

<!-- Le problème, puis la solution. Si une issue existe : « Corrige #123 ». -->

## Pourquoi

<!-- Ce qui a motivé ce choix, et les compromis éventuels. -->

## Vérifications réellement effectuées

<!-- Cochez ce que vous avez VRAIMENT lancé. Une case cochée à tort coûte plus cher
     qu'une case vide : elle fait croire que la couche est couverte. -->

- [ ] `npm run build` (renderer, tsc strict)
- [ ] `npm run check:core` (backend `core/`)
- [ ] `npm run check:i18n` (textes et traductions)
- [ ] `node --test test/*.test.cjs`
- [ ] `python -m unittest discover -s test -p "test_*.py"`
- [ ] Testé en runtime dans l'application (`run.bat`)

## Ce qui n'a pas pu être testé

<!-- Soyez explicite. Beaucoup de chemins exigent Resolve Studio, Premiere, After Effects,
     un GPU NVIDIA ou des modèles téléchargés — dire ce qui n'a pas tourné est aussi utile
     que dire ce qui a tourné. -->

## Captures

<!-- Obligatoire pour tout changement visuel. Une courte vidéo pour une interaction. -->

---

- [ ] Code, commits et titre de PR en anglais idiomatique ; interface et commentaires en français
- [ ] Une seule modification par PR (refactorisation et changement fonctionnel séparés)
- [ ] Toute nouvelle IPC est alignée aux 3 endroits (table `H` de `core/rpc.js`, `NrApi` + `coreClient.ts`, `mock` de `bridge.ts`)
- [ ] Toute dépendance runtime ajoutée met aussi à jour le packaging (`scripts/build.ps1`, `setup.ps1`, `test/packaging.test.cjs`)
