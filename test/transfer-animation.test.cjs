// Chaîne d'animation du transfert : extraction depuis un export FCP7 XML, greffe sur le document lu
// par l'API, puis fabrication de la composition Fusion qui la repose dans Resolve. Tout est PUR ici —
// aucun hôte n'est requis, contrairement au montage lui-même.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseXmeml } = require('../core/transfer/xmeml');
const { mergeAnimation, pairClips } = require('../core/transfer/mergeAnimation');
const { buildAnimatedComp, readSkeleton, skeletonHasAnimation, clipIsAnimated } = require('../core/transfer/fusion/compText');

// --- lecture xmeml ---------------------------------------------------------------------------

/** Deux images clés de position sur un plan : le mouvement « de droite à gauche » du montage. */
const XMEML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5"><sequence id="s1">
  <name>Montage</name><duration>240</duration>
  <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
  <media>
    <video>
      <format><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></format>
      <track>
        <clipitem id="c1">
          <name>plan A</name><start>0</start><end>50</end><in>10</in><out>60</out>
          <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
          <file id="f1"><name>A.mov</name><pathurl>file://localhost/C:/rush/A.mov</pathurl>
            <duration>500</duration>
            <media><video><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video></media>
          </file>
          <filter><effect>
            <name>Basic Motion</name><effectid>basic</effectid>
            <effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>
            <parameter><parameterid>center</parameterid><name>Center</name>
              <keyframe><when>10</when><value><horiz>-0.25</horiz><vert>0</vert></value><interpolation><name>Linear</name></interpolation></keyframe>
              <keyframe><when>60</when><value><horiz>0.25</horiz><vert>0</vert></value><interpolation><name>Linear</name></interpolation></keyframe>
            </parameter>
            <parameter><parameterid>scale</parameterid><name>Scale</name><value>150</value></parameter>
          </effect></filter>
        </clipitem>
      </track>
    </video>
    <audio>
      <track>
        <clipitem id="c2">
          <name>plan A son</name><start>0</start><end>50</end><in>10</in><out>60</out>
          <file id="f1"/>
          <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
          <filter><effect>
            <name>Audio Levels</name><effectid>audiolevels</effectid>
            <effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>
            <parameter><parameterid>level</parameterid><name>Level</name><value>0.5</value></parameter>
          </effect></filter>
        </clipitem>
      </track>
    </audio>
  </media>
</sequence></xmeml>`;

test('un export FCP7 XML rend ses images clés en frames de plan et en pixels', () => {
  const doc = parseXmeml(XMEML, { host: 'resolve' });
  assert.equal(doc.ok, true);
  assert.equal(doc.clips.length, 2);
  const video = doc.clips.find((c) => c.kind === 'video');
  assert.equal(video.path, 'C:/rush/A.mov');
  assert.equal(video.srcIn, 10);
  assert.equal(video.srcOut, 59, 'la borne de sortie xmeml est exclusive, celle du document inclusive');
  const keys = video.video.transform.position.keyframes;
  // `when` est en frames du FICHIER ; le document les veut relatives au début du plan.
  assert.deepEqual(keys.map((k) => k.frame), [0, 50]);
  assert.equal(Math.round(keys[0].value.x), -480, '-0,25 de largeur sur 1920 px');
  assert.equal(Math.round(keys[1].value.x), 480);
  // Le niveau audio xmeml est LINÉAIRE ; le document le porte en décibels.
  const audio = doc.clips.find((c) => c.kind === 'audio');
  assert.ok(Math.abs(audio.audio.gainDb.value + 6.02) < 0.05);
});

test('les frames de la timeline suivent la vitesse du plan', () => {
  // Plan ralenti : 100 frames source étalées sur 50 frames de timeline.
  const slow = XMEML.replace('<out>60</out>\n          <rate>', '<out>110</out>\n          <rate>');
  const doc = parseXmeml(slow, { host: 'resolve' });
  const video = doc.clips.find((c) => c.kind === 'video');
  const keys = video.video.transform.position.keyframes;
  assert.deepEqual(keys.map((k) => k.frame), [0, 25], 'une clé au milieu de la source tombe au milieu du plan');
});

// --- greffe sur le document lu par l'API -------------------------------------------------------

const apiClip = (over = {}) => ({
  kind: 'video', track: 1, path: 'C:\\rush\\A.mov', name: 'plan A', fps: 25, srcFrames: 500,
  srcIn: 10, srcOut: 59, tlStart: 0, tlEnd: 50,
  video: { transform: { position: { value: { x: 0, y: 0 } } } }, ...over,
});
const doc = (clips) => ({ ok: true, host: 'resolve', timeline: 'T', fps: 25, width: 1920, height: 1080, startFrame: 0, endFrame: 50, clips, missing: [] });

test('la greffe ajoute les images clés sans toucher aux bornes lues par l’API', () => {
  const base = doc([apiClip()]);
  const overlay = parseXmeml(XMEML, { host: 'resolve' });
  const merged = mergeAnimation(base, doc(overlay.clips.filter((c) => c.kind === 'video')));
  assert.equal(merged.animatedClips, 1);
  const clip = merged.doc.clips[0];
  assert.equal(clip.srcIn, 10, 'les bornes viennent de l’API, jamais du XML');
  assert.equal(clip.video.transform.position.keyframes.length, 2);
});

test('une piste dont les deux lectures ne comptent pas pareil n’est jamais appariée', () => {
  // Cas d'une timeline imbriquée : l'API l'aplatit en deux plans, l'export XML n'en montre qu'un.
  const base = [apiClip(), apiClip({ tlStart: 50, tlEnd: 90 })];
  const { pairs, unmatched } = pairClips(base, [apiClip()]);
  assert.equal(pairs.length, 0);
  assert.deepEqual(unmatched, [0, 1]);
});

test('un plan sans image clé n’est pas compté comme animé', () => {
  const merged = mergeAnimation(doc([apiClip()]), doc([apiClip()]));
  assert.equal(merged.animatedClips, 0);
});

// --- composition Fusion ------------------------------------------------------------------------

/** Squelette tel que `ExportFusionComp` le produit sur un plan de la page Montage. */
const SKELETON = `{
	Tools = ordered() {
		MediaIn1 = MediaIn {
			Inputs = { Layer = Input { Value = "0", }, },
			ViewInfo = OperatorInfo { Pos = { 0, 0 } },
		},
		MediaOut1 = MediaOut {
			Inputs = {
				Input = Input {
					SourceOp = "MediaIn1",
					Source = "Output",
				},
			},
			ViewInfo = OperatorInfo { Pos = { 110, 0 } },
		}
	},
	ActiveTool = "MediaOut1"
}`;

const animatedClip = {
  kind: 'video', track: 1, path: 'C:/rush/A.mov', name: 'plan A', fps: 25, srcFrames: 500,
  srcIn: 10, srcOut: 59, tlStart: 0, tlEnd: 50, srcWidth: 1920, srcHeight: 1080,
  video: { transform: {
    position: { value: { x: -480, y: 0 }, keyframes: [
      { frame: 0, value: { x: -480, y: 0 } }, { frame: 50, value: { x: 480, y: 0 } },
    ] },
    opacity: { value: 100, keyframes: [{ frame: 0, value: 0 }, { frame: 12, value: 100 }] },
    rotation: { value: 90 },
  } },
};

test('le squelette exporté livre ses points de greffe', () => {
  const skeleton = readSkeleton(SKELETON);
  assert.equal(skeleton.mediaIn, 'MediaIn1');
  assert.equal(skeleton.mediaOut, 'MediaOut1');
  assert.deepEqual(skeleton.upstream, { op: 'MediaIn1', source: 'Output' });
});

test('la composition animée s’intercale entre MediaIn et MediaOut', () => {
  const built = buildAnimatedComp(SKELETON, animatedClip, { width: 1920, height: 1080 });
  assert.equal(built.ok, true);
  const text = built.text;
  assert.match(text, /NRTransform = Transform \{/);
  assert.match(text, /Input = Input \{ SourceOp = "MediaIn1", Source = "Output", \}/);
  // MediaOut doit désormais lire la sortie du fondu, dernier maillon de la chaîne greffée.
  assert.match(text, /MediaOut1 = MediaOut \{[\s\S]*SourceOp = "NRFade"/);
  assert.ok(skeletonHasAnimation(text));
});

test('les valeurs passent dans l’espace Fusion : normalisé, origine en bas à gauche', () => {
  const built = buildAnimatedComp(SKELETON, animatedClip, { width: 1920, height: 1080 });
  // -480 px sur 1920 → 0,5 - 0,25 = 0,25 ; +480 px → 0,75.
  assert.match(built.text, /NRTransformCenterX = BezierSpline \{[\s\S]*\[0\] = \{ 0\.25,[\s\S]*\[50\] = \{ 0\.75,/);
  // Le montage tourne dans le sens horaire, Fusion dans l'autre.
  assert.match(built.text, /Angle = Input \{ Value = -90, \}/);
  // Opacité 0→100 % devient un multiplicateur d'ALPHA 0→1, posé par un opérateur pixel à pixel.
  // Un Merge sur fond plein imposerait la taille de ce fond à la sortie de la comp et court-
  // circuiterait l'ajustement automatique de Resolve : le plan arrivait débordé.
  assert.match(built.text, /NRFadeAlpha = BezierSpline \{[\s\S]*\[0\] = \{ 0,[\s\S]*\[12\] = \{ 1,/);
  assert.match(built.text, /NRFade = BrightnessContrast \{/);
  assert.doesNotMatch(built.text, /Background \{/);
});

test("une opacité à 100 % ne pose AUCUN nœud : rien à corriger, rien à risquer", () => {
  const clip = {
    ...animatedClip,
    video: { transform: { ...animatedClip.video.transform, opacity: { value: 100 } } },
  };
  const built = buildAnimatedComp(SKELETON, clip, { width: 1920, height: 1080 });
  assert.equal(built.ok, true);
  assert.doesNotMatch(built.text, /NRFade/);
  // La sortie reste branchée sur la transformation, pas sur un nœud d'opacité inexistant.
  assert.match(built.text, /MediaOut1 = MediaOut \{[\s\S]*SourceOp = "NRTransform"/);
});

test('un plan sans image clé ne déclenche aucune composition', () => {
  assert.equal(clipIsAnimated({ video: { transform: { position: { value: { x: 1, y: 2 } } } } }), false);
  assert.equal(clipIsAnimated(animatedClip), true);
});

test('un squelette illisible est refusé plutôt que réparé au hasard', () => {
  assert.deepEqual(buildAnimatedComp('{ Tools = ordered() { } }', animatedClip, { width: 1920, height: 1080 }),
    { ok: false, reason: 'fusionSkeletonUnreadable' });
});
