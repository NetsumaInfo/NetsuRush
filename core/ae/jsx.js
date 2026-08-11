// @ts-check
// Génère le script ExtendScript (.jsx) lancé par AfterFX.exe : importe les médias, pose les calques,
// applique transforms/time-remap, crée les précompos. JAMAIS d'alert() (un modal bloque AE en
// arrière-plan) → toutes les erreurs partent dans un log fichier.

function genAeScript(payload, logPath) {
  const json = JSON.stringify(payload);
  const logJson = JSON.stringify(logPath);
  return `var DATA = ${json};
var NR_LOG = ${logJson};
function nrLog(s) { try { var f = new File(NR_LOG); f.open("a"); f.write(s + "\\n"); f.close(); } catch (e) {} }
app.beginUndoGroup("NetsuRush -> After Effects");
try {
  var comp = app.project.items.addComp(DATA.comp.name, DATA.comp.w, DATA.comp.h, 1.0, DATA.comp.dur, DATA.comp.fps);
  var cache = {};
  function findExisting(p) {
    var want;
    try { want = new File(p).fsName.toLowerCase(); } catch (e) { return null; }
    for (var k = 1; k <= app.project.numItems; k++) {
      var it = app.project.item(k);
      if (it instanceof FootageItem && it.file) {
        try { if (it.file.fsName.toLowerCase() === want) return it; } catch (e2) {}
      }
    }
    return null;
  }
  function imp(p) {
    if (cache[p]) return cache[p];
    var ex = findExisting(p);
    if (ex) { cache[p] = ex; return ex; }
    var io = new ImportOptions();
    io.file = new File(p);
    var f = app.project.importFile(io);
    cache[p] = f;
    return f;
  }
  var bins = {};
  function bin(name) {
    if (!DATA.folders) return null;
    if (!bins[name]) bins[name] = app.project.items.addFolder(name);
    return bins[name];
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function lin(prop) {
    try { for (var q = 1; q <= prop.numKeys; q++) prop.setInterpolationTypeAtKey(q, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); } catch (e) {}
  }
  // Transform Resolve → calque AE. Resolve fit la source à la comp puis applique Zoom/Pan/Tilt/Rot ;
  // AE pose la source à sa taille native → on multiplie l'échelle par le facteur de fit (scale-to-fit).
  function applyXf(tc, lyr, f, x) {
    try {
      var fit = Math.min(tc.width / f.width, tc.height / f.height);
      var sx = fit * x.zoomX * 100 * (x.flipX ? -1 : 1);
      var sy = fit * x.zoomY * 100 * (x.flipY ? -1 : 1);
      var tr = lyr.transform;
      tr.scale.setValue([sx, sy]);
      tr.position.setValue([tc.width / 2 + x.pan, tc.height / 2 - x.tilt]);  // Tilt + = haut → y AE décroît
      tr.rotation.setValue(x.rot);
      tr.opacity.setValue(x.opacity);
      if (x.anchorX || x.anchorY) tr.anchorPoint.setValue([f.width / 2 + x.anchorX, f.height / 2 - x.anchorY]);
      if (x.cropL || x.cropR || x.cropT || x.cropB) {
        var l = x.cropL, r = f.width - x.cropR, t = x.cropT, b = f.height - x.cropB;
        var m = lyr.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        var sh = new Shape();
        sh.vertices = [[l, t], [r, t], [r, b], [l, b]];
        sh.closed = true;
        m.property("ADBE Mask Shape").setValue(sh);
      }
    } catch (e) { nrLog("xf KO: " + e.toString()); }
  }
  function keyType(name) {
    if (name === "hold") return KeyframeInterpolationType.HOLD;
    if (name === "bezier") return KeyframeInterpolationType.BEZIER;
    return KeyframeInterpolationType.LINEAR;
  }
  function pt(v, dx, dy) {
    return (v && typeof v.x === "number") ? [v.x, v.y] : [dx, dy];
  }
  // Images clés lues dans l'export FCP7 de Resolve (l'API n'en expose aucune). Convention du
  // document d'échange, PAS celle des propriétés brutes de applyXf : position en pixels de timeline
  // depuis le centre (Y vers le BAS, d'où le + là où Tilt donnait un −), échelle en facteur, ancrage
  // en pixels source depuis le coin haut-gauche. Posées APRÈS applyXf : une propriété animée
  // remplace sa valeur fixe, les autres la gardent.
  function applyAnim(tc, lyr, f, L) {
    var a = L.anim;
    if (!a) return;
    try {
      var fit = Math.min(tc.width / f.width, tc.height / f.height);
      var fx = (L.xf && L.xf.flipX) ? -1 : 1;
      var fy = (L.xf && L.xf.flipY) ? -1 : 1;
      var fps = L.keyFps || DATA.comp.fps;
      var tr = lyr.transform;
      var map = [
        [tr.position, a.position, function (v) { var p = pt(v, 0, 0); return [tc.width / 2 + p[0], tc.height / 2 + p[1]]; }],
        [tr.scale, a.scale, function (v) { var p = pt(v, 1, 1); return [fit * p[0] * 100 * fx, fit * p[1] * 100 * fy]; }],
        [tr.anchorPoint, a.anchor, function (v) { var p = pt(v, f.width / 2, f.height / 2); return [p[0], p[1]]; }],
        [tr.rotation, a.rotation, function (v) { return Number(v) || 0; }],
        [tr.opacity, a.opacity, function (v) { return Number(v) || 0; }]
      ];
      for (var i = 0; i < map.length; i++) {
        var prop = map[i][0], src = map[i][1], conv = map[i][2];
        if (!prop || !src || !src.keyframes || !src.keyframes.length) continue;
        var posed = [];
        for (var k = 0; k < src.keyframes.length; k++) {
          try {
            var tk = L.keyStart + (Number(src.keyframes[k].frame) || 0) / fps;
            prop.setValueAtTime(tk, conv(src.keyframes[k].value));
            posed.push({ t: tk, i: src.keyframes[k].interpolation });
          } catch (e1) { nrLog("key KO: " + e1.toString()); }
        }
        // Interpolations posées APRÈS toutes les clés : AE renumérote à chaque ajout.
        for (var q = 0; q < posed.length; q++) {
          try {
            var ty = keyType(posed[q].i);
            prop.setInterpolationTypeAtKey(prop.nearestKeyIndex(posed[q].t), ty, ty);
          } catch (e2) {}
        }
      }
    } catch (e) { nrLog("anim KO: " + e.toString()); }
  }
  // Place un calque dans la comp cible tc (comp principale ou précompo de timeline imbriquée).
  function placeLayer(tc, L) {
    var f;
    try { f = imp(L.file); } catch (e) { nrLog("import KO: " + L.file + " -> " + e.toString()); return null; }
    var still = !!L.image;
    try { still = still || !!(f.mainSource && f.mainSource.isStill); } catch (e) {}
    if (DATA.folders) {
      var dest = still ? "Images" : (L.kind === "audio" ? "Audio" : "Rushes");
      try { f.parentFolder = bin(dest); } catch (e) {}
    }
    var lyr = tc.layers.add(f);
    if (L.retime) {
      // Vitesse : time-remap linéaire entre [remapIn, remapOut] sur l'intervalle timeline.
      try {
        lyr.timeRemapEnabled = true;
        var rm = lyr.property("ADBE Time Remapping");
        rm.setValueAtTime(L.posSec, L.remapIn);
        rm.setValueAtTime(L.posSec + L.occSec, L.remapOut);
        for (var nk = rm.numKeys; nk >= 1; nk--) {
          var kt = rm.keyTime(nk);
          if (kt < L.posSec - 1e-5 || kt > L.posSec + L.occSec + 1e-5) rm.removeKey(nk);
        }
        lin(rm);
        lyr.inPoint = L.posSec;
        lyr.outPoint = L.posSec + L.occSec;
      } catch (e) { nrLog("retime KO: " + e.toString()); }
    } else if (still) {
      // Image fixe : pas de temps source → on cale juste sur [inPoint, inPoint + occSec].
      lyr.startTime = L.inPoint;
      lyr.inPoint = L.inPoint;
      lyr.outPoint = L.inPoint + L.occSec;
    } else {
      lyr.startTime = L.startTime;
      // inPoint AVANT outPoint : sinon le setter inPoint d'AE décale l'outPoint, calques en bloc.
      if (L.inPoint != null) lyr.inPoint = L.inPoint;
      if (L.outPoint != null) lyr.outPoint = L.outPoint;
    }
    if (DATA.transforms && L.xf) applyXf(tc, lyr, f, L.xf);
    if (DATA.transforms) applyAnim(tc, lyr, f, L);
    if (L.name) { try { lyr.name = L.name; } catch (e) {} }
    // Journal du média RÉELLEMENT importé : une fois la comp ouverte, « pas le bon fichier » et
    // « pas la bonne portion » se ressemblent.
    nrLog("layer " + (L.name || "?") + " [" + L.kind + "] in=" + lyr.inPoint.toFixed(3)
      + " out=" + lyr.outPoint.toFixed(3) + " start=" + lyr.startTime.toFixed(3)
      + (L.xfBaked ? " xf-cuit" : (L.xf ? " xf" : "")) + (L.anim ? " keys" : "") + " <- " + L.file);
    return { lyr: lyr, still: still };
  }
  var added = 0, failed = 0;
  var videoLayers = [];
  var audioLayers = [];
  // Timelines imbriquées en mode 'comp' : une précompo AE dédiée par timeline.
  var groupComps = {};
  for (var gi = 0; gi < DATA.groups.length; gi++) {
    var G = DATA.groups[gi];
    try {
      groupComps[G.id] = app.project.items.addComp(G.name, G.w, G.h, 1.0, G.dur, G.fps);
      if (DATA.folders) { try { groupComps[G.id].parentFolder = bin("Timelines"); } catch (e) {} }
    } catch (e) { nrLog("nested comp KO: " + e.toString()); }
  }
  for (var i = 0; i < DATA.layers.length; i++) {
    var L = DATA.layers[i];
    var tc = L.group ? groupComps[L.group] : comp;
    if (!tc) { failed++; continue; }
    var r = placeLayer(tc, L);
    if (!r) { failed++; continue; }
    added++;
    if (!L.group && L.kind === "video") videoLayers.push(r);
    if (L.kind === "audio") audioLayers.push(r.lyr);
  }
  // Chaque précompo imbriquée posée dans la comp principale, trimmée à la fenêtre du plan parent.
  for (var gj = 0; gj < DATA.groups.length; gj++) {
    var G2 = DATA.groups[gj];
    var gc = groupComps[G2.id];
    if (!gc) continue;
    try {
      var gl = comp.layers.add(gc);
      gl.startTime = G2.place.startTime;
      gl.inPoint = G2.place.inPoint;
      gl.outPoint = G2.place.outPoint;
    } catch (e) { nrLog("nested place KO: " + e.toString()); }
  }
  // Précompose les calques selon la cible (vidéos / images / les deux).
  //
  // moveAllAttributes = TRUE : transforms, images clés, masque de recadrage et time-remap partent
  // DANS la précompo, sur le rush lui-même. À false ils restaient sur le calque de précompo,
  // au-dessus d'un rush brut — impossible d'aller retoucher un zoom animé là où il se travaille.
  // Contrepartie : AE donne alors à la précompo la durée de la comp parente et pose le calque sur
  // toute sa longueur. On lui rend ses bornes d'origine, sinon chaque plan s'étalerait sur toute la
  // timeline et le montage deviendrait illisible (le temps reste 1:1, startTime remis à 0).
  if (DATA.precomp) {
    var cnt = 0;
    for (var v = 0; v < videoLayers.length; v++) {
      var isImg = videoLayers[v].still;
      var want = DATA.precompTarget === "both" || (isImg ? DATA.precompTarget === "image" : DATA.precompTarget === "video");
      if (!want) continue;
      cnt++;
      var pn = DATA.precompNaming === "number" ? pad(cnt) : videoLayers[v].lyr.name + " — Précomp";
      var li = videoLayers[v].lyr.index;
      var wasIn = videoLayers[v].lyr.inPoint;
      var wasOut = videoLayers[v].lyr.outPoint;
      try {
        var pc = comp.layers.precompose([li], pn, true);
        var outer = comp.layer(li);
        // precompose nomme la comp mais pas le calque parent → le renommer aussi.
        try { outer.name = pn; } catch (e) {}
        try {
          outer.startTime = 0;
          // inPoint AVANT outPoint : le setter inPoint d'AE décale sinon l'outPoint.
          outer.inPoint = wasIn;
          outer.outPoint = wasOut;
        } catch (e4) { nrLog("precomp trim KO: " + e4.toString()); }
        if (DATA.folders && pc) { try { pc.parentFolder = bin("Précomps"); } catch (e) {} }
      } catch (e3) { nrLog("precompose KO: " + e3.toString()); }
    }
  }
  // Le son TOUJOURS sous les images : layers.add() insère en HAUT de la pile. Le rangement se fait
  // ici, une fois les précompos imbriquées posées et les plans précomposés, sinon ces insertions
  // remonteraient l'audio.
  // Balayé dans l'ordre de pose (piste croissante) → A1 reste au-dessus de A2, comme dans Resolve.
  for (var a = 0; a < audioLayers.length; a++) {
    try { audioLayers[a].moveToEnd(); } catch (e) { nrLog("audio order KO: " + e.toString()); }
  }
  try { comp.openInViewer(); } catch (e) {}
  nrLog("OK comp=\\"" + comp.name + "\\" calques=" + added + " echecs=" + failed + " precomp=" + (DATA.precomp ? 1 : 0));
} catch (err) {
  nrLog("ERREUR: " + err.toString() + " (ligne " + err.line + ")");
}
app.endUndoGroup();
`;
}

module.exports = { genAeScript };
