// @ts-check
// Génération FCPXML pour la « Découpe de timeline ». Resolve importe ce fichier (ImportTimelineFromFile)
// comme un MONTAGE NATIF : les plans consécutifs d'un même rush, source-contigus, deviennent des
// through-edits reconnus → supprimables/joignables comme un vrai montage. L'API scripting n'expose
// aucun blade/split, donc l'import est la seule voie pour des coupes « normales ».
//
// Temps en secondes RATIONNELLES exactes (frame × frameDuration) → frame-accurate, zéro drift.
// `start` (point d'entrée source) dans la base de temps du clip ; `offset`/`duration` (position et
// durée timeline) dans la base de la séquence. Pour un rush au même fps que la séquence c'est exact ;
// fps différent → conformé par Resolve à l'import.

// fps réel → fraction exacte. NTSC (23.976/29.97/59.94…) = N×1000/1001 ; entiers = N/1.
function fpsRational(fps) {
  const f = Number(fps) || 24;
  const ntsc = Math.round(f * 1.001);                 // 23.976→24, 29.97→30, 59.94→60
  if (ntsc > 0 && Math.abs(f - ntsc / 1.001) < 0.02) return { num: ntsc * 1000, den: 1001 };
  const whole = Math.round(f);
  if (whole > 0 && Math.abs(f - whole) < 0.02) return { num: whole, den: 1 };
  return { num: Math.round(f * 1000), den: 1000 };
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// clips: [{ src, name, fps:{num,den}, totalFrames, w, h, shots:[{ startFrame, frames }] }]
function buildFcpxml({ projectName, eventName = 'NetsuRush', clips }) {
  const seq = clips[0].fps;

  // Formats dédupliqués par (fps, résolution).
  const formats = [];
  const fmtId = (fps, w, h) => {
    const key = `${fps.num}/${fps.den}/${w}/${h}`;
    let f = formats.find((x) => x.key === key);
    if (!f) { f = { key, id: `r${formats.length + 1}`, fps, w, h }; formats.push(f); }
    return f.id;
  };

  const assetEls = [];
  let aSeq = 1;
  for (const c of clips) {
    c.formatId = fmtId(c.fps, c.w || 1920, c.h || 1080);
    c.assetId = `a${aSeq++}`;
    const durNum = c.totalFrames * c.fps.den;
    assetEls.push(
      `<asset id="${c.assetId}" name="${esc(c.name)}" start="0s" duration="${durNum}/${c.fps.num}s" `
      + `hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000" format="${c.formatId}">`
      + `<media-rep kind="original-media" src="${esc(c.src)}"/></asset>`,
    );
  }

  // Spine : un asset-clip par plan, offsets cumulés en frames de séquence.
  const spine = [];
  let offFrames = 0;
  let n = 1;
  for (const c of clips) {
    const { num: clipNum, den: clipDen } = c.fps;
    const sameFps = clipNum === seq.num && clipDen === seq.den;
    for (const sh of c.shots) {
      const startNum = sh.startFrame * clipDen;       // entrée source (base du clip)
      const tlFrames = sameFps
        ? sh.frames
        : Math.max(1, Math.round((sh.frames * clipDen / clipNum) * (seq.num / seq.den)));
      spine.push(
        `<asset-clip ref="${c.assetId}" offset="${offFrames * seq.den}/${seq.num}s" `
        + `name="${esc(c.name)} · plan ${n}" start="${startNum}/${c.fps.num}s" `
        + `duration="${tlFrames * seq.den}/${seq.num}s" format="${c.formatId}" tcFormat="NDF"/>`,
      );
      offFrames += tlFrames;
      n++;
    }
  }

  const fmtEls = formats.map((f) =>
    `<format id="${f.id}" frameDuration="${f.fps.den}/${f.fps.num}s" width="${f.w || 1920}" height="${f.h || 1080}"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>${fmtEls}${assetEls.join('')}</resources>
  <library>
    <event name="${esc(eventName)}">
      <project name="${esc(projectName)}">
        <sequence format="${clips[0].formatId}" duration="${offFrames * seq.den}/${seq.num}s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>${spine.join('')}</spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

module.exports = { buildFcpxml, fpsRational };
