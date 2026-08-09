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
    if (L.name) { try { lyr.name = L.name; } catch (e) {} }
    return { lyr: lyr, still: still };
  }
  var added = 0, failed = 0;
  var videoLayers = [];
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
  // Précompose les calques selon la cible (vidéos / images / les deux). moveAllAttributes=false :
  // laisse les attributs, la comp prend la taille du plan (pas celle de la timeline).
  if (DATA.precomp) {
    var cnt = 0;
    for (var v = 0; v < videoLayers.length; v++) {
      var isImg = videoLayers[v].still;
      var want = DATA.precompTarget === "both" || (isImg ? DATA.precompTarget === "image" : DATA.precompTarget === "video");
      if (!want) continue;
      cnt++;
      var pn = DATA.precompNaming === "number" ? pad(cnt) : videoLayers[v].lyr.name + " — Précomp";
      var li = videoLayers[v].lyr.index;
      try {
        var pc = comp.layers.precompose([li], pn, false);
        // precompose nomme la comp mais pas le calque parent → le renommer aussi.
        try { comp.layer(li).name = pn; } catch (e) {}
        if (DATA.folders && pc) { try { pc.parentFolder = bin("Précomps"); } catch (e) {} }
      } catch (e3) { nrLog("precompose KO: " + e3.toString()); }
    }
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
