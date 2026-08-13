const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'reference', 'useScenePersistence.ts'),
  'utf8',
);

test('Save As uses the chosen netsu filename as the project name everywhere', () => {
  const saveAs = source.slice(source.indexOf('const saveProjectAs'), source.indexOf('// Ouvre un projet'));
  assert.match(saveAs, /const projectName = fileLabel\(dest\)/);
  // La scène part par `savable`, qui porte aussi les médias retenus par l'historique : ce qui
  // compte ici est que le nom envoyé soit celui du FICHIER choisi, pas celui du board d'avant.
  assert.match(saveAs, /scene: \{ \.\.\.savable\(projectName\) \}/);
  assert.match(saveAs, /sceneName: fileLabel\(res\.path \?\? dest\)/);
});

test('opening an older project also normalizes its scene name from the netsu filename', () => {
  const open = source.slice(source.indexOf('const openProject'), source.indexOf('const recentProjects'));
  assert.match(open, /name: fileLabel\(res\.path \?\? srcPath\)/);
});
