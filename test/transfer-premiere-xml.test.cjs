// Lecture des images clés d'une séquence Premiere par son propre export FCP7 XML.
// Le XML est la SOURCE D'ANIMATION du pont Premiere → Resolve, comme il l'est déjà côté Resolve :
// le snapshot du panneau porte la structure, l'export porte les courbes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseXmeml } = require('../core/transfer/xmeml');
const { readSequenceXml, graftPremiereAnimation } = require('../core/transfer/premiereXml');
const { docFromAdobeSequence, normalizeDoc } = require('../core/transfer/doc');

/** Export tel que Premiere l'écrit : Basic Motion et Opacity animés, Audio Levels animé. */
const PREMIERE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>Montage</name>
    <duration>100</duration>
    <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <format><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></format>
        <track>
          <clipitem id="clipitem-1">
            <name>a.mov</name>
            <start>0</start><end>50</end><in>0</in><out>50</out>
            <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
            <file id="file-1">
              <name>a.mov</name>
              <pathurl>file://localhost/C:/rush/a.mov</pathurl>
              <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
              <duration>500</duration>
              <media><video><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video></media>
            </file>
            <filter>
              <effect>
                <name>Basic Motion</name>
                <effectid>basic</effectid>
                <parameter authoringApp="PremierePro">
                  <parameterid>scale</parameterid>
                  <name>Scale</name>
                  <value>100</value>
                  <keyframe><when>0</when><value>100</value></keyframe>
                  <keyframe><when>25</when><value>150</value></keyframe>
                </parameter>
                <parameter authoringApp="PremierePro">
                  <parameterid>center</parameterid>
                  <name>Center</name>
                  <keyframe><when>0</when><value><horiz>0</horiz><vert>0</vert></value></keyframe>
                  <keyframe><when>50</when><value><horiz>0.25</horiz><vert>-0.1</vert></value></keyframe>
                </parameter>
              </effect>
            </filter>
            <filter>
              <effect>
                <name>Opacity</name>
                <effectid>opacity</effectid>
                <parameter authoringApp="PremierePro">
                  <parameterid>opacity</parameterid>
                  <name>opacity</name>
                  <value>100</value>
                  <keyframe><when>0</when><value>100</value></keyframe>
                  <keyframe><when>50</when><value>0</value></keyframe>
                </parameter>
              </effect>
            </filter>
          </clipitem>
        </track>
      </video>
      <audio>
        <track>
          <clipitem id="clipitem-2">
            <name>m.wav</name>
            <start>0</start><end>50</end><in>0</in><out>50</out>
            <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
            <file id="file-2">
              <name>m.wav</name>
              <pathurl>file://localhost/C:/rush/m.wav</pathurl>
              <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
            </file>
            <filter>
              <effect>
                <name>Audio Levels</name>
                <effectid>audiolevels</effectid>
                <parameter authoringApp="PremierePro">
                  <parameterid>level</parameterid>
                  <name>Level</name>
                  <value>1</value>
                  <keyframe><when>0</when><value>1</value></keyframe>
                  <keyframe><when>50</when><value>0.0625</value></keyframe>
                </parameter>
              </effect>
            </filter>
          </clipitem>
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>`;

/** Snapshot du panneau : la structure, SANS aucune propriété — le cas observé en production. */
function snapshot() {
  return {
    app: 'ppro',
    activeSequence: 'Montage',
    sequences: [{
      name: 'Montage', fps: 25, w: 1920, h: 1080,
      tracks: [
        {
          kind: 'video', index: 1,
          clips: [{
            name: 'a.mov', path: 'C:/rush/a.mov', srcFps: 25,
            srcInFrame: 0, srcOutFrame: 49, tlStartFrame: 0, tlEndFrame: 50, direct: true,
          }],
        },
        {
          kind: 'audio', index: 1,
          clips: [{
            name: 'm.wav', path: 'C:/rush/m.wav', srcFps: 25,
            srcInFrame: 0, srcOutFrame: 49, tlStartFrame: 0, tlEndFrame: 50, direct: true,
          }],
        },
      ],
    }],
  };
}

function hostWriting(xml, extra = {}) {
  return {
    calls: [],
    exportXml(filePath, timelineName) {
      this.calls.push({ filePath, timelineName });
      if (extra.refuse) return Promise.resolve({ ok: false, errorCode: 'UNSUPPORTED_OP' });
      fs.writeFileSync(filePath, xml, 'utf8');
      return Promise.resolve({ ok: true, path: filePath, sequence: 'Montage' });
    },
  };
}

test("l'analyseur xmeml lit un export Premiere comme un export Resolve", () => {
  const doc = parseXmeml(PREMIERE_XML, { host: 'ppro', sequenceName: 'Montage' });
  assert.equal(doc.ok, true);
  assert.equal(doc.timeline, 'Montage');
  assert.equal(doc.clips.length, 2);
  const video = doc.clips.find((c) => c.kind === 'video');
  assert.equal(video.video.transform.scale.keyframes.length, 2);
  assert.equal(video.video.transform.opacity.keyframes.length, 2);
  const audio = doc.clips.find((c) => c.kind === 'audio');
  assert.equal(audio.audio.gainDb.keyframes.length, 2);
  // Niveau linéaire 0,0625 = -24 dB : le document parle en décibels, comme les hôtes.
  assert.equal(Math.round(audio.audio.gainDb.keyframes[1].value), -24);
});

test('la séquence est choisie par son NOM : un export porte aussi les imbriquées', () => {
  const nested = PREMIERE_XML.replace('<sequence id="sequence-1">',
    '<sequence id="sequence-0"><name>Imbriquée</name><media><video><track></track></video></media></sequence><sequence id="sequence-1">');
  const doc = parseXmeml(nested, { host: 'ppro', sequenceName: 'Montage' });
  assert.equal(doc.ok, true);
  assert.equal(doc.timeline, 'Montage');
});

test("les images clés de l'export se greffent sur le document du snapshot", async () => {
  const base = normalizeDoc(docFromAdobeSequence(snapshot(), 'Montage'));
  // Le snapshot n'a lu AUCUNE propriété : c'est exactement ce qui se produit quand les composants
  // intrinsèques ne sont pas atteignables, et ce que le XML vient réparer.
  assert.equal(base.clips[0].video, undefined);

  const host = hostWriting(PREMIERE_XML);
  const grafted = await graftPremiereAnimation(host, base, 'Montage');
  assert.equal(grafted.animation.available, true);
  assert.equal(grafted.animation.clips, 2);
  assert.equal(grafted.animation.unpaired, 0);

  const video = grafted.doc.clips.find((c) => c.kind === 'video');
  assert.equal(video.video.transform.scale.keyframes.length, 2);
  assert.equal(video.video.transform.scale.keyframes[1].value.x, 1.5);
  assert.equal(video.video.transform.opacity.keyframes[1].value, 0);
  const audio = grafted.doc.clips.find((c) => c.kind === 'audio');
  assert.equal(audio.audio.gainDb.keyframes.length, 2);

  // Les bornes du snapshot restent la vérité : le XML n'apporte QUE l'animation.
  assert.equal(video.srcIn, 0);
  assert.equal(video.srcOut, 49);
  assert.equal(video.tlEnd, 50);
});

test("le fichier d'échange est effacé après la greffe, réussite comme échec", async () => {
  const base = normalizeDoc(docFromAdobeSequence(snapshot(), 'Montage'));
  const host = hostWriting(PREMIERE_XML);
  await graftPremiereAnimation(host, base, 'Montage');
  assert.equal(host.calls.length, 1);
  assert.equal(fs.existsSync(host.calls[0].filePath), false);
  // Le fichier vit dans NR_HOME et porte un nom STABLE : `%TEMP%` avec un nom horodaté cumulait
  // deux variables qu'on ne pouvait plus départager quand Resolve refusait l'import sans un mot.
  assert.equal(path.basename(host.calls[0].filePath), 'netsurush-transfer.xml');
  assert.notEqual(path.dirname(host.calls[0].filePath), os.tmpdir());
});

test('un export refusé laisse le document intact et le DIT', async () => {
  const base = normalizeDoc(docFromAdobeSequence(snapshot(), 'Montage'));
  const grafted = await graftPremiereAnimation(hostWriting(PREMIERE_XML, { refuse: true }), base, 'Montage');
  assert.equal(grafted.animation.available, false);
  assert.equal(grafted.animation.reason, 'UNSUPPORTED_OP');
  assert.equal(grafted.doc.clips.length, base.clips.length);
});

test('un export vide ne fait pas échouer la lecture', async () => {
  const base = normalizeDoc(docFromAdobeSequence(snapshot(), 'Montage'));
  const grafted = await graftPremiereAnimation(hostWriting(''), base, 'Montage');
  assert.equal(grafted.animation.available, false);
  assert.equal(grafted.animation.reason, 'sequenceExportEmpty');
});

test("un hôte qui lève l'exception rend une raison, jamais un plantage", async () => {
  const base = normalizeDoc(docFromAdobeSequence(snapshot(), 'Montage'));
  const host = { exportXml: () => Promise.reject(new Error('panneau muet')) };
  const read = await readSequenceXml(host, 'Montage');
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'panneau muet');
});

test("une piste dont les deux lectures divergent n'est pas appariée au hasard", async () => {
  const snap = snapshot();
  snap.sequences[0].tracks[0].clips.push({
    name: 'b.mov', path: 'C:/rush/b.mov', srcFps: 25,
    srcInFrame: 0, srcOutFrame: 49, tlStartFrame: 50, tlEndFrame: 100, direct: true,
  });
  const base = normalizeDoc(docFromAdobeSequence(snap, 'Montage'));
  const grafted = await graftPremiereAnimation(hostWriting(PREMIERE_XML), base, 'Montage');
  // La piste vidéo compte 2 plans côté snapshot, 1 côté XML : aucune greffe vidéo, l'audio passe.
  assert.equal(grafted.animation.unpaired, 2);
  assert.equal(grafted.doc.clips.find((c) => c.kind === 'video').video, undefined);
  assert.equal(grafted.animation.clips, 1);
});
