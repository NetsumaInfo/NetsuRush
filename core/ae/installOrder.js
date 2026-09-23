// @ts-check
// Order of the Adobe installs found on disk. The folder name carries the version ("Adobe After
// Effects 2025", "Adobe Premiere Pro CC 2019", "Adobe After Effects CS6"): an alphabetical sort puts
// "CC 2019" after "2025" and launched the oldest install.

/// Release year of an install folder, or a smaller number for the pre-year names.
function installVersion(installPath) {
  const text = String(installPath || '');
  const year = /(?:^|[^0-9])((?:19|20)[0-9]{2})(?![0-9])/.exec(text);
  if (year) return Number(year[1]);
  if (/\bCC\b/i.test(text)) return 2013; // the first Creative Cloud release had no year
  const cs = /\bCS([0-9]+)\b/i.exec(text);
  if (cs) return Number(cs[1]);
  return 0; // "(Beta)" and unknown names come after every numbered release
}

/// Newest install first; the same version keeps the previous reverse-alphabetical order.
function sortNewestFirst(paths) {
  return paths.slice().sort((a, b) => installVersion(b) - installVersion(a) || (a < b ? 1 : a > b ? -1 : 0));
}

module.exports = { installVersion, sortNewestFirst };
