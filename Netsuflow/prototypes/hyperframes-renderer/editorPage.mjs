// The editor's page, kept apart from the server that serves it.
//
// Two panes, and each one owns its own scrolling. An earlier layout nested a
// percentage-capped parameter list inside a flex column inside a page grid,
// which meant three things could scroll and none of them predictably; with 22
// declared variables it was unusable. Here the shell never scrolls, and exactly
// one element inside each pane does.
//
// The left pane is one panel with a tab strip, not a stack: code, parameters
// and export are alternatives, never all at once, so none has to give up height
// to the others. It collapses entirely, because the preview is the thing being
// judged and it should be able to have the window.
//
// The preview has one playhead and one play button for both of its modes. They
// used to have their own, which is why switching modes appeared to jump or
// start playing on its own — two clocks disagreeing, not a player misbehaving.

export const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8" />
<title>NetsuFlow — composition</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #131318; --panel: #18181f; --sunk: #0d0d11; --line: #26262e;
    --ink: #d7d7e0; --dim: #9a9ab0; --faint: #6a6a80;
    --accent: #5a67f2; --good: #2f9e6a; --bad: #ff7a90;
  }
  * { box-sizing: border-box; }
  /* One rule, because the alternative was a recurring bug. The hidden attribute
     is styled by the user-agent sheet, so any author rule beats it: an id
     selector setting display flex left the code pane on screen beside the panel
     meant to replace it, and a class rule kept the H.264 quality field visible
     under a PNG export. Hiding has to outrank layout. */
  [hidden] { display: none !important; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; overflow: hidden;
         font: 13px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--ink); }

  button { border: 0; border-radius: 6px; padding: 7px 14px; font: inherit; font-weight: 600;
           cursor: pointer; background: #2f2f3d; color: var(--ink); }
  button:hover { background: #3a3a4a; }
  button.primary { background: var(--accent); color: #fff; }
  button.send { background: var(--good); color: #fff; }
  button:disabled { background: #33334a; color: #777; cursor: default; }
  input, select { font: inherit; background: var(--sunk); border: 1px solid #2c2c36;
                  color: var(--ink); border-radius: 5px; padding: 6px 8px; }
  input:disabled, select:disabled { color: #666; }
  h3 { margin: 0 0 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .09em;
       color: var(--faint); font-weight: 600; }
  p.explain { margin: 4px 0 0; color: var(--dim); font-size: 12px; }
  code.path { font: 11px/1.5 Consolas, ui-monospace, monospace; color: var(--dim);
              word-break: break-all; }

  /* ---- left pane ---- */
  #left { flex: 0 0 clamp(360px, 38%, 620px); display: flex; flex-direction: column;
          min-width: 0; min-height: 0; border-right: 1px solid var(--line);
          background: var(--panel); }
  body.collapsed #left { flex-basis: 0; border-right: 0; overflow: hidden; }
  body.collapsed #left > * { display: none; }

  .strip { display: flex; align-items: center; gap: 4px; padding: 8px 10px;
           border-bottom: 1px solid var(--line); flex: 0 0 auto; }
  .strip button { border-radius: 6px; padding: 6px 13px; font-weight: 500;
                  background: transparent; color: var(--dim); }
  .strip button.on { background: var(--bg); color: #fff; font-weight: 600; }
  .strip .count { font-size: 11px; color: var(--faint); margin-left: 2px; }
  .spacer { flex: 1; }
  .icon { padding: 6px 10px; background: transparent; color: var(--dim); font-size: 15px; }

  /* Exactly one scroller per pane. */
  #panes { flex: 1; min-height: 0; display: flex; }
  .pane { flex: 1; min-width: 0; min-height: 0; }
  #codePane { display: flex; }
  #code { flex: 1; resize: none; border: 0; outline: 0; padding: 12px; background: var(--sunk);
          color: #cdd6f4; font: 12px/1.5 Consolas, ui-monospace, monospace; white-space: pre;
          tab-size: 2; overflow: auto; }
  #paramPane, #exportPane, #cachePane { overflow-y: auto; overflow-x: hidden;
                                        padding: 4px 14px 16px; }

  /* The disk cost, stated once and largely, because it is the number that
     decides whether to press Vider. */
  .gauge { display: flex; align-items: baseline; gap: 10px; padding: 6px 0 10px; }
  .gauge b { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .gauge span { color: var(--dim); }

  .section { padding: 12px 0 6px; }
  .section + .section { border-top: 1px solid var(--line); margin-top: 8px; }

  /* One row per variable. The label column is fixed rather than fluid so
     twenty rows read as a column of labels instead of a ragged edge. */
  .p { display: grid; grid-template-columns: 132px minmax(0, 1fr) auto;
       gap: 10px; align-items: center; padding: 5px 0; }
  .p.tall { align-items: start; }
  .p > label { color: #b8b8c8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
               padding-top: 2px; }
  .p .field { min-width: 0; display: flex; gap: 6px; align-items: center; }
  .p .field > input[type=text], .p .field > select, .p .field > textarea { flex: 1; min-width: 0; }
  .p textarea { resize: vertical; min-height: 58px; font: inherit; line-height: 1.4;
                background: var(--sunk); border: 1px solid #2c2c36; color: var(--ink);
                border-radius: 5px; padding: 6px 8px; }
  .p input[type=range] { flex: 1; min-width: 0; }
  .p input.num { width: 76px; text-align: right; font-variant-numeric: tabular-nums; }
  /* The swatch is a button showing the colour over a checker, so a lowered
     alpha reads as transparency instead of as a darker colour. */
  .swatch { flex: 0 0 auto; width: 34px; height: 26px; border-radius: 5px; padding: 0;
            border: 1px solid #2c2c36; cursor: pointer; position: relative; overflow: hidden;
            background: repeating-conic-gradient(#5a5a66 0 25%, #8a8a96 0 50%) 0 0 / 12px 12px; }
  .swatch i { position: absolute; inset: 0; }
  .p input.hex { width: 92px; font: 12px/1.5 Consolas, ui-monospace, monospace;
                 text-transform: lowercase; }

  /* ---- colour popover ---- */
  #cpop { position: fixed; z-index: 60; width: 216px; background: var(--panel);
          border: 1px solid var(--line); border-radius: 8px; padding: 10px;
          box-shadow: 0 16px 48px #000b; display: flex; flex-direction: column; gap: 8px;
          touch-action: none; }
  #cpSv { position: relative; height: 126px; border-radius: 6px; cursor: crosshair;
          background-image: linear-gradient(to top, #000, rgba(0,0,0,0)),
                            linear-gradient(to right, #fff, rgba(255,255,255,0)); }
  #cpSv i { position: absolute; width: 12px; height: 12px; margin: -6px; border-radius: 50%;
            border: 2px solid #fff; box-shadow: 0 0 0 1px #0008; pointer-events: none; }
  .cstrip { position: relative; height: 14px; border-radius: 7px; cursor: ew-resize; }
  .cstrip i { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px;
              border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #0008;
              pointer-events: none; }
  #cpHue { background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
  #cpA { background: repeating-conic-gradient(#5a5a66 0 25%, #8a8a96 0 50%) 0 0 / 12px 12px; }
  #cpA b { position: absolute; inset: 0; border-radius: 7px; pointer-events: none; }
  .cpal { display: flex; flex-wrap: wrap; gap: 4px; }
  .cpal button { width: 19px; height: 19px; border-radius: 4px; padding: 0;
                 border: 1px solid #0006; cursor: pointer; }
  .unit { color: var(--faint); font-size: 12px; }
  /* Reset is present on every row and only inked when it would do something,
     so rows never reflow as values change. */
  .reset { background: transparent; color: transparent; padding: 4px 6px; font-size: 13px;
           cursor: default; }
  .p.dirty .reset { color: var(--dim); cursor: pointer; }
  .p.dirty .reset:hover { color: #fff; background: #2f2f3d; }
  .p.dirty > label { color: #fff; }
  .val { color: var(--dim); text-align: right; font-variant-numeric: tabular-nums;
         overflow: hidden; text-overflow: ellipsis; }
  .none { color: var(--faint); padding: 8px 0; }
  .grouphead { color: var(--faint); font-size: 11px; text-transform: uppercase;
               letter-spacing: .08em; padding: 12px 0 2px; border-top: 1px solid var(--line);
               margin-top: 6px; }
  .grouphead:first-child { border-top: 0; margin-top: 0; padding-top: 2px; }
  #paramSearch { width: 100%; margin: 2px 0 4px; }
  #paramEmpty { color: var(--faint); padding: 8px 0; }

  /* ---- form rows ---- */
  .row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; align-items: center;
         padding: 5px 0; }
  .row > label { color: var(--dim); }
  .row input, .row select { width: 100%; min-width: 0; }
  .range { display: flex; align-items: center; gap: 8px; }
  .range input { width: 84px; text-align: right; font-variant-numeric: tabular-nums; }
  .range span { color: var(--faint); }

  /* ---- format ---- */
  .fmt { display: grid; grid-template-columns: auto 1fr; gap: 8px 10px; align-items: center;
         padding: 8px 0 2px; }
  .fmt .dim { color: var(--dim); }
  .sizes { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; }
  .sizes button { padding: 5px 10px; font-weight: 500; font-size: 12px; background: #23232e;
                  color: var(--ink); text-align: left; }
  .sizes button b { color: #fff; }
  .sizes button span { color: var(--faint); font-weight: 400; }
  .sizes button.on { outline: 1px solid var(--accent); }
  .custom { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; }
  .custom input { width: 82px; text-align: right; font-variant-numeric: tabular-nums; }
  .custom .x { color: var(--faint); }

  /* ---- directory picker ---- */
  .picker { display: flex; gap: 6px; min-width: 0; }
  .picker input { flex: 1; min-width: 0; }

  /* A dialog rather than a panel wedged into the form: choosing a folder needs
     room to list one, and the form behind it should stay where the user left
     it instead of being pushed around. */
  #pick { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center;
          background: #000a; }
  #pick .dialog { width: min(620px, 92vw); height: min(520px, 86vh); display: flex;
                  flex-direction: column; background: var(--panel); border: 1px solid var(--line);
                  border-radius: 10px; box-shadow: 0 24px 80px #000b; overflow: hidden; }
  #pick header { display: flex; gap: 6px; align-items: center; padding: 10px;
                 border-bottom: 1px solid var(--line); }
  #pick header input { flex: 1; min-width: 0; font: 12px/1.5 Consolas, ui-monospace, monospace; }
  #pick .body { flex: 1; min-height: 0; display: flex; }
  #pick nav { flex: 0 0 148px; border-right: 1px solid var(--line); padding: 8px;
              display: flex; flex-direction: column; gap: 3px; }
  #pick nav button { text-align: left; padding: 6px 9px; font-size: 12px; font-weight: 500;
                     background: transparent; color: var(--dim); }
  #pick nav button:hover { background: #23232e; color: var(--ink); }
  #pick .listing { flex: 1; min-width: 0; overflow-y: auto; padding: 6px; }
  #pick .listing button { display: block; width: 100%; text-align: left; padding: 6px 9px;
                          background: transparent; font-weight: 400; border-radius: 4px;
                          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #pick .listing button:hover { background: #23232e; }
  #pick .listing .empty { color: var(--faint); padding: 10px; }
  #pick footer { display: flex; gap: 8px; align-items: center; padding: 10px;
                 border-top: 1px solid var(--line); }
  #pick footer .spacer { flex: 1; }
  #pick footer span { color: var(--faint); font-size: 12px; }

  /* ---- progress ---- */
  .bar { display: flex; align-items: center; gap: 8px; color: var(--dim);
         font-variant-numeric: tabular-nums; font-size: 12px; padding: 6px 0; }
  .bar[hidden] { display: none; }
  .track { flex: 1; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
  .fill { height: 100%; width: 0; background: var(--accent); transition: width .2s linear; }
  .actions { display: flex; gap: 8px; align-items: center; padding: 8px 0 0; }

  /* ---- bottom bar ---- */
  #bar { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
         padding: 10px; border-top: 1px solid var(--line); }
  #status { flex: 1 0 100%; min-width: 0; color: var(--dim); overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
  #status.err { color: var(--bad); }
  #status.ok { color: #6fe0a4; }

  /* ---- right pane ---- */
  #right { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  /* A dark backdrop hides exactly what a compositing preview must show: a black
     overlay at low alpha. Light checker by default, switchable, because an
     overlay reads on one background and a bright graphic on another. */
  #view { flex: 1; min-height: 0; display: grid; place-items: center; overflow: hidden;
          position: relative; }
  #view.checker { background: repeating-conic-gradient(#d8d8de 0 25%, #f2f2f6 0 50%) 0 0 / 24px 24px; }
  #view.dark { background: #0b0b0f; }
  #view.light { background: #ffffff; }
  #view.mid { background: #808080; }
  #stage { position: relative; box-shadow: 0 8px 40px #0009; }
  #stage[hidden] { display: none; }
  #live { border: 0; display: block; background: transparent; }
  #frame { max-width: 96%; max-height: 96%; box-shadow: 0 8px 40px #0009; }
  #frame[hidden] { display: none; }
  #scrub { flex: 0 0 auto; display: flex; gap: 10px; align-items: center; padding: 10px 14px;
           background: var(--panel); border-top: 1px solid var(--line); }
  #slider { flex: 1; min-width: 0; }
  #fno { width: 104px; text-align: right; color: var(--dim); font-variant-numeric: tabular-nums; }
  .bg { display: flex; gap: 4px; }
  .bg button { padding: 5px 9px; font-weight: 500; font-size: 12px; }
  .bg button.on { background: var(--accent); color: #fff; }
  #note { flex: 0 0 auto; padding: 7px 14px; color: var(--dim); background: var(--panel);
          border-top: 1px solid var(--line); min-height: 30px; font-size: 12px; }
  #modeNote { color: var(--faint); font-size: 12px; margin-left: 6px; }
</style>

<div id="left">
  <div class="strip">
    <button id="tabCode" class="on">Code</button>
    <button id="tabParams">Paramètres<span class="count" id="paramCount"></span></button>
    <button id="tabExport">Export</button>
    <button id="tabCache">Cache</button>
    <span class="spacer"></span>
    <button id="collapse" class="icon" title="Replier le panneau">&#9664;</button>
  </div>

  <div id="panes">
    <div id="codePane" class="pane">
      <textarea id="code" spellcheck="false" placeholder="Colle ton code ici."></textarea>
    </div>

    <div id="paramPane" class="pane" hidden>
      <div class="section">
        <h3>Format</h3>
        <div class="fmt">
          <div class="sizes" id="offers"></div>
          <label for="preset" class="dim">Préréglage</label>
          <select id="preset">
            <optgroup label="Suivre le code">
              <option value="auto">Ce que la composition déclare</option>
            </optgroup>
            <optgroup label="Horizontal">
              <option value="1920x1080">1920 × 1080 — 16:9</option>
              <option value="2560x1440">2560 × 1440 — 16:9</option>
              <option value="3840x2160">3840 × 2160 — 4K</option>
            </optgroup>
            <optgroup label="Vertical">
              <option value="1080x1920">1080 × 1920 — 9:16</option>
              <option value="720x1280">720 × 1280 — 9:16</option>
              <option value="1440x2560">1440 × 2560 — 9:16</option>
              <option value="2160x3840">2160 × 3840 — 4K vertical</option>
              <option value="1080x1350">1080 × 1350 — 4:5</option>
              <option value="1080x1440">1080 × 1440 — 3:4</option>
            </optgroup>
            <optgroup label="Carré">
              <option value="1080x1080">1080 × 1080 — 1:1</option>
              <option value="2048x2048">2048 × 2048 — 1:1</option>
            </optgroup>
            <optgroup label="Autre">
              <option value="custom">Personnalisé</option>
            </optgroup>
          </select>
          <div class="custom">
            <input id="fw" type="number" min="16" max="8192" step="2" />
            <span class="x">×</span>
            <input id="fh" type="number" min="16" max="8192" step="2" />
            <span class="dim" id="fmtNote"></span>
          </div>
        </div>
      </div>

      <div class="section">
        <h3>Variables de la composition</h3>
        <input id="paramSearch" type="search" placeholder="Filtrer…" hidden />
        <div id="params"></div>
        <div id="paramEmpty" hidden>Aucune variable ne correspond.</div>
      </div>
    </div>

    <div id="exportPane" class="pane" hidden>
      <div class="section">
        <h3>Export</h3>
        <div class="row">
          <label for="exFormat">Format</label>
          <select id="exFormat"></select>
        </div>
        <div class="row" id="exQualityRow" hidden>
          <label for="exQuality">Qualité</label>
          <div class="range">
            <input id="exQuality" type="number" min="0" max="51" step="1" value="18"
              title="CRF : plus bas = plus fidèle, plus lourd" />
            <span>CRF</span>
          </div>
        </div>
        <div class="row">
          <label for="exDir">Dossier</label>
          <div class="picker">
            <input id="exDir" type="text" spellcheck="false" />
            <button id="exBrowse">Parcourir…</button>
          </div>
        </div>
        <div class="row">
          <label for="exName">Nom</label>
          <input id="exName" type="text" spellcheck="false" />
        </div>
        <div class="row">
          <label for="exFrom">Frames</label>
          <div class="range">
            <input id="exFrom" type="number" min="0" step="1" value="0" />
            <span id="exToLbl">à</span>
            <input id="exTo" type="number" min="0" step="1" value="0" />
            <span id="exRangeNote"></span>
          </div>
        </div>
        <div class="actions">
          <button id="exGo" class="primary">Exporter</button>
          <button id="exStop" hidden>Annuler</button>
          <span id="exState" class="explain"></span>
        </div>
        <div class="bar" id="exBar" hidden>
          <div class="track"><div class="fill" id="exFill"></div></div>
          <span id="exText"></span>
        </div>
      </div>

    </div>

    <div id="cachePane" class="pane" hidden>
      <div class="section">
        <h3 id="bakeTitle">Cache Fusion</h3>
        <div class="gauge">
          <b id="bakeSize">–</b>
          <span id="bakeState"></span>
        </div>
        <div class="row">
          <label for="bakeQuality">Stockage</label>
          <select id="bakeQuality"></select>
        </div>
        <div class="actions">
          <button id="bake" title="Pré-calcule les images pour une lecture fluide dans Fusion. Pas un export.">Pré-calculer</button>
          <button id="bakeClear" title="Supprime toutes les images en cache maintenant">Vider</button>
        </div>
        <div class="bar" id="bakeBar" hidden>
          <div class="track"><div class="fill" id="bakeFill"></div></div>
          <span id="bakeText"></span>
        </div>
        <p class="explain" id="bakeAuto"></p>
        <p class="explain"><code class="path" id="bakePath"></code></p>
      </div>
    </div>
  </div>

  <div id="bar">
    <button id="apply" class="primary">Appliquer</button>
    <button id="send" class="send" title="Donne cette version au nœud dans Resolve">Envoyer au nœud</button>
    <span id="status">chargement…</span>
  </div>
</div>

<div id="right">
  <div class="strip">
    <button id="expand" class="icon" title="Déplier le panneau" hidden>&#9654;</button>
    <button id="tabLive" class="on">Live</button>
    <button id="tabRendu">Rendu</button>
    <span id="modeNote"></span>
    <span class="spacer"></span>
    <span class="bg">
      <button data-bg="checker" class="on">damier</button>
      <button data-bg="dark">noir</button>
      <button data-bg="mid">gris</button>
      <button data-bg="light">blanc</button>
    </span>
  </div>
  <div id="view" class="checker">
    <div id="stage"><iframe id="live" src="/live"></iframe></div>
    <img id="frame" alt="" hidden />
  </div>
  <div id="scrub">
    <button id="playBtn">&#9654;</button>
    <input id="slider" type="range" min="0" max="0" value="0" step="1" disabled />
    <span id="fno">–</span>
  </div>
  <div id="note"></div>
</div>

<div id="cpop" hidden>
  <div id="cpSv"><i></i></div>
  <div id="cpHue" class="cstrip"><i></i></div>
  <div id="cpA" class="cstrip" hidden><b></b><i></i></div>
  <div class="cpal" id="cpPal"></div>
</div>

<div id="pick" hidden>
  <div class="dialog">
    <header>
      <button id="brUp" title="Dossier parent">&#8593;</button>
      <input id="brPath" spellcheck="false" />
    </header>
    <div class="body">
      <nav id="brShortcuts"></nav>
      <div class="listing" id="brList"></div>
    </div>
    <footer>
      <span id="brNote"></span>
      <span class="spacer"></span>
      <button id="brClose">Annuler</button>
      <button id="brPick" class="primary">Choisir</button>
    </footer>
  </div>
</div>

<script>
'use strict';
const $ = (id) => document.getElementById(id);

// The page follows the browser's language, which follows the OS — the same
// signal Resolve itself follows. Authored in French; English is an overlay.
const LANG = (navigator.language || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';
const L = LANG === 'fr' ? {
  loading: 'chargement…',
  applying: 'application…',
  sendingNode: 'envoi au nœud…',
  sentNode: 'envoyé au nœud',
  revision: 'révision',
  frames: 'frames',
  images: 'images',
  onTotal: 'sur',
  noSizes: 'Le code ne déclare aucune taille.',
  alreadyApplied: 'Déjà appliqué',
  renderAtSize: 'Rendre à cette taille',
  codeSize: 'taille demandée par le code',
  codeAsks: 'le code demande',
  modeLive: 'rendu navigateur, fluide',
  modeRendu: 'pixels envoyés à Resolve',
  liveTag: 'Live',
  transparentNote: 'Transparent — change le fond.',
  opaque: 'opaque',
  noParams: 'Aucune variable déclarée.',
  resetTitle: 'Revenir à la valeur du code',
  ffmpegMissing: 'ffmpeg introuvable',
  writtenTo: 'écrit dans',
  cached: 'en cache',
  interrupted: 'interrompu :',
  unreadable: 'illisible',
  noSubfolder: 'Aucun sous-dossier.',
  openedBtn: 'Ouvert…',
  bakeAuto: 'Vidé automatiquement à chaque changement de paramètre.',
  qFast: 'Rapide — compressé, sans perte',
  qCompact: 'Compact — plus petit, encodage plus lent',
  qRaw: 'Brut — non compressé, lecture la plus directe',
  lossless: 'Toutes les options sont sans perte : pixels rendus au bit près.',
} : {
  loading: 'loading…',
  applying: 'applying…',
  sendingNode: 'sending to node…',
  sentNode: 'sent to node',
  revision: 'revision',
  frames: 'frames',
  images: 'frames',
  onTotal: 'of',
  noSizes: 'The code declares no size.',
  alreadyApplied: 'Already applied',
  renderAtSize: 'Render at this size',
  codeSize: 'size the code asks for',
  codeAsks: 'the code asks for',
  modeLive: 'browser render, fluid',
  modeRendu: 'the pixels Resolve receives',
  liveTag: 'Live',
  transparentNote: 'Transparent — switch the backdrop.',
  opaque: 'opaque',
  noParams: 'No declared variables.',
  resetTitle: 'Back to the value in the code',
  ffmpegMissing: 'ffmpeg not found',
  writtenTo: 'written to',
  cached: 'cached',
  interrupted: 'interrupted:',
  unreadable: 'unreadable',
  noSubfolder: 'No subfolder.',
  openedBtn: 'Open…',
  bakeAuto: 'Cleared automatically whenever a parameter changes.',
  qFast: 'Fast — compressed, lossless',
  qCompact: 'Compact — smaller, slower to encode',
  qRaw: 'Raw — uncompressed, the most direct read',
  lossless: 'Every option is lossless: the pixels come back identical.',
};

// Static markup is authored in French; this walks it once for English.
function applyEnglish() {
  const texts = {
    tabParams: 'Parameters', tabRendu: 'Render', apply: 'Apply', send: 'Send to node',
    exBrowse: 'Browse…', exGo: 'Export', exStop: 'Cancel', bake: 'Pre-render',
    bakeTitle: 'Fusion cache', brClose: 'Cancel', brPick: 'Choose', exToLbl: 'to',
    bakeClear: 'Empty',
    paramEmpty: 'No match.',
  };
  for (const [id, text] of Object.entries(texts)) {
    const el = $(id);
    if (!el) continue;
    // Keep child count badges and the like intact by touching text nodes only.
    if (el.firstChild && el.firstChild.nodeType === 3) el.firstChild.nodeValue = text;
    else el.textContent = text;
  }
  const titles = {
    collapse: 'Collapse the panel', expand: 'Expand the panel',
    send: 'Hands this version to the node in Resolve', brUp: 'Parent folder',
    bake: 'Pre-renders frames for fluid playback in Fusion. Not an export.',
    bakeClear: 'Deletes every cached frame now',
    exQuality: 'CRF: lower = truer, larger',
  };
  for (const [id, title] of Object.entries(titles)) { if ($(id)) $(id).title = title; }
  $('code').placeholder = 'Paste your code here.';
  $('paramSearch').placeholder = 'Filter…';
  const labels = { exFormat: 'Format', exQuality: 'Quality', exDir: 'Folder',
                   exName: 'Name', exFrom: 'Frames', preset: 'Preset',
                   bakeQuality: 'Storage' };
  for (const label of document.querySelectorAll('label[for]')) {
    if (labels[label.htmlFor]) label.textContent = labels[label.htmlFor];
  }
  const groups = { 'Suivre le code': 'Follow the code', Horizontal: 'Landscape',
                   Vertical: 'Portrait', 'Carré': 'Square', Autre: 'Other' };
  for (const group of $('preset').querySelectorAll('optgroup')) {
    if (groups[group.label]) group.label = groups[group.label];
  }
  const auto = $('preset').querySelector('option[value=auto]');
  if (auto) auto.textContent = 'What the code declares';
  const custom = $('preset').querySelector('option[value=custom]');
  if (custom) custom.textContent = 'Custom';
  const bgs = { checker: 'checker', dark: 'black', mid: 'grey', light: 'white' };
  for (const button of document.querySelectorAll('.bg button')) {
    if (bgs[button.dataset.bg]) button.textContent = bgs[button.dataset.bg];
  }
  const h3s = document.querySelectorAll('#paramPane h3, #exportPane h3');
  for (const h3 of h3s) { if (h3.textContent === 'Variables de la composition') h3.textContent = 'Variables'; }
}
if (LANG !== 'fr') applyEnglish();

const PLAY = '\\u25B6';
const PAUSE = '\\u2759\\u2759';

const MODE_NOTE = { live: L.modeLive, rendu: L.modeRendu };

let state = null;
let vars = {};

/// One playhead and one play flag for both preview modes. Each mode used to
/// keep its own, which is why switching appeared to jump or to start playing by
/// itself: two clocks, not one player.
let frameNow = 0;
let playing = false;
let mode = 'live';
let renderTimer = null;
let scrubTimer = null;

function say(text, kind) {
  $('status').textContent = text;
  $('status').className = kind || '';
}

const fps = () => (state && state.fps) || 24;
const lastFrame = () => Number($('slider').max) || 0;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

async function load() {
  const data = await (await fetch('/api/state')).json();
  $('code').value = data.html;
  adopt(data);
  await loadExportOptions();
  pollBake();
}

function adopt(data) {
  state = data;
  $('slider').max = Math.max(0, (data.durationFrames || 1) - 1);
  $('slider').disabled = false;

  $('fw').value = data.width;
  $('fh').value = data.height;
  if ($('preset').value !== 'auto') {
    const asPreset = data.width + 'x' + data.height;
    $('preset').value = [...$('preset').querySelectorAll('option')]
      .some((o) => o.value === asPreset) ? asPreset : 'custom';
  }
  buildOffers(data.requested || []);
  buildParams(data.variables || []);

  $('exTo').value = Math.max(0, (data.durationFrames || 1) - 1);
  $('exRangeNote').textContent = L.onTotal + ' ' + (data.durationFrames || 0);

  say(data.width + ' × ' + data.height + ' · ' + data.fps + ' fps · '
    + (data.durationFrames || 0) + ' ' + L.frames);
  fitStage();
  seek(Math.min(frameNow, lastFrame()));
}

/// What the pasted code asks for, offered rather than guessed at. A component
/// authored at 1080x1920 and rendered at 1920x1080 does not letterbox — it lays
/// out wrong — and reading the source to find that out is not the user's job.
function buildOffers(requested) {
  const offers = $('offers');
  offers.innerHTML = '';
  if (!requested.length) {
    const empty = document.createElement('span');
    empty.className = 'dim';
    empty.textContent = L.noSizes;
    offers.appendChild(empty);
    $('fmtNote').textContent = '';
    return;
  }
  for (const entry of requested) {
    const active = entry.width === state.width && entry.height === state.height;
    const button = document.createElement('button');
    const size = document.createElement('b');
    size.textContent = entry.width + ' × ' + entry.height;
    const origin = document.createElement('span');
    origin.textContent = ' ' + entry.source;
    button.append(size, origin);
    button.title = active ? L.alreadyApplied : L.renderAtSize;
    button.classList.toggle('on', active);
    button.onclick = () => {
      $('preset').value = 'custom';
      $('fw').value = entry.width;
      $('fh').value = entry.height;
      apply();
    };
    offers.appendChild(button);
  }
  const first = requested[0];
  $('fmtNote').textContent = first.width === state.width && first.height === state.height
    ? L.codeSize
    : L.codeAsks + ' ' + first.width + ' × ' + first.height;
}

// The composition renders at its own size and is scaled to the pane, so both
// preview modes frame the picture identically.
function fitStage() {
  const w = (state && state.width) || 1920;
  const h = (state && state.height) || 1080;
  const live = $('live');
  const view = $('view');
  live.width = w;
  live.height = h;
  live.style.width = w + 'px';
  live.style.height = h + 'px';
  const scale = Math.min((view.clientWidth * 0.96) / w, (view.clientHeight * 0.96) / h, 1);
  live.style.transformOrigin = 'top left';
  live.style.transform = 'scale(' + scale + ')';
  $('stage').style.width = Math.round(w * scale) + 'px';
  $('stage').style.height = Math.round(h * scale) + 'px';
}
addEventListener('resize', fitStage);

/// null means "let the composition's own declaration decide", which is what the
/// Auto preset is for. Anything else is an explicit override.
function chosenSize() {
  if ($('preset').value === 'auto') return null;
  return { width: Number($('fw').value) || 0, height: Number($('fh').value) || 0 };
}

async function post(path, body) {
  const reply = await fetch(path, body === undefined ? { method: 'POST' } : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await reply.json();
  if (!reply.ok) throw new Error(data.error || reply.statusText);
  return data;
}

async function apply() {
  $('apply').disabled = true;
  say(L.applying);
  try {
    adopt(await post('/api/save', { html: $('code').value, vars, ...(chosenSize() ?? {}) }));
    reloadLive();
  } catch (error) {
    say(error.message, 'err');
  } finally {
    $('apply').disabled = false;
  }
}

// Sending is separate from applying on purpose: the node should change when
// asked, not on every keystroke's worth of preview.
async function send() {
  $('send').disabled = true;
  say(L.sendingNode);
  try {
    const data = await post('/api/send');
    say(L.sentNode + ' · ' + data.width + ' × ' + data.height
      + ' · ' + L.revision + ' ' + data.revision, 'ok');
  } catch (error) {
    say(error.message, 'err');
  } finally {
    $('send').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Transport — one playhead, two ways of showing it
// ---------------------------------------------------------------------------

function setPlaying(next) {
  playing = next;
  $('playBtn').textContent = next ? PAUSE : PLAY;
  if (mode === 'live') {
    stopRenderedLoop();
    toLive({ type: next ? 'hf-play' : 'hf-pause' });
    return;
  }
  toLive({ type: 'hf-pause' });
  if (next) startRenderedLoop(); else stopRenderedLoop();
}

/// Moves the playhead. Both modes are told, so switching between them never
/// has to reconcile two positions — there is only ever one.
function seek(frame) {
  frameNow = Math.max(0, Math.min(frame, lastFrame()));
  $('slider').value = frameNow;
  $('fno').textContent = frameNow + ' / ' + lastFrame();
  toLive({ type: 'hf-seek', t: frameNow / fps() });
  if (mode === 'rendu') showFrame(frameNow);
}

function setMode(next) {
  mode = next;
  const isLive = next === 'live';
  $('tabLive').classList.toggle('on', isLive);
  $('tabRendu').classList.toggle('on', !isLive);
  $('stage').hidden = !isLive;
  $('frame').hidden = isLive;
  $('modeNote').textContent = MODE_NOTE[next];
  // The playhead and the play state survive the switch untouched. Only the way
  // they are shown changes.
  toLive({ type: 'hf-seek', t: frameNow / fps() });
  if (!isLive) showFrame(frameNow);
  setPlaying(playing);
}

function stopRenderedLoop() {
  clearInterval(renderTimer);
  renderTimer = null;
}

// Rendered playback is only honest once the frames exist: a fresh 1080p frame
// costs ~300 ms and a pre-calculated one ~40 ms, so this steps at the
// composition's rate and falls behind while frames are still being made. The
// live mode has no such ceiling, which is the whole reason it exists.
function startRenderedLoop() {
  stopRenderedLoop();
  let busy = false;
  renderTimer = setInterval(async () => {
    if (busy || mode !== 'rendu' || !playing) return;
    busy = true;
    let next = frameNow + 1;
    if (next > lastFrame()) next = 0;
    frameNow = next;
    $('slider').value = next;
    $('fno').textContent = next + ' / ' + lastFrame();
    await showFrame(next);
    busy = false;
  }, 1000 / fps());
}

function toLive(message) {
  $('live').contentWindow?.postMessage(message, '*');
}

function reloadLive() {
  $('live').src = '/live?t=' + Date.now();
}

async function showFrame(n) {
  const reply = await fetch('/api/frame?n=' + n);
  if (!reply.ok) {
    const data = await reply.json().catch(() => ({}));
    say(data.error || reply.statusText, 'err');
    setPlaying(false);
    return;
  }
  const opaque = reply.headers.get('x-opaque-pixels');
  if (opaque !== null) {
    const total = (state?.width ?? 0) * (state?.height ?? 0);
    // Said outright, because a transparent composition on the wrong backdrop
    // looks exactly like a composition that failed to render.
    $('note').textContent = Number(opaque) === 0
      ? L.transparentNote
      : Math.round((Number(opaque) / total) * 100) + ' % ' + L.opaque;
  }
  const blob = await reply.blob();
  const img = $('frame');
  const previous = img.src;
  img.src = URL.createObjectURL(blob);
  if (previous) URL.revokeObjectURL(previous);
}

addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type === 'hf-ready') {
    $('note').textContent = L.liveTag + ' · ' + message.duration.toFixed(2) + ' s';
    toLive({ type: 'hf-seek', t: frameNow / fps() });
    toLive({ type: playing && mode === 'live' ? 'hf-play' : 'hf-pause' });
  } else if (message.type === 'hf-time') {
    // Only the live mode's own clock may move the playhead, and only while it
    // is the one on screen and actually running.
    if (mode !== 'live' || !playing) return;
    frameNow = Math.min(lastFrame(), Math.round(message.t * fps()));
    $('slider').value = frameNow;
    $('fno').textContent = frameNow + ' / ' + lastFrame();
  } else if (message.type === 'hf-error') {
    $('note').textContent = message.message;
  }
});

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/// One row per declared variable, grouped the way the author grouped them, and
/// typed the way the declaration types them. The control matters: a colour
/// edited through a text field is a colour nobody adjusts, and a hundred-
/// character explanation edited through a fifteen-character box is worse.
let declaredNow = [];

function buildParams(declared) {
  declaredNow = declared;
  $('paramCount').textContent = declared.length ? ' ' + declared.length : '';
  // The filter only earns its space once the list is long enough to need it.
  $('paramSearch').hidden = declared.length < 8;
  renderParams();
}

function renderParams() {
  const paramsBox = $('params');
  paramsBox.innerHTML = '';

  if (!declaredNow.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = L.noParams;
    paramsBox.appendChild(none);
    $('paramEmpty').hidden = true;
    return;
  }

  const needle = $('paramSearch').hidden ? '' : $('paramSearch').value.trim().toLowerCase();
  const matches = (entry) => needle === ''
    || (entry.label || '').toLowerCase().includes(needle)
    || entry.id.toLowerCase().includes(needle)
    || (entry.description || '').toLowerCase().includes(needle);

  // Insertion order within each group, groups in first-seen order: the author's
  // ordering is information, and sorting alphabetically would discard it.
  const groups = new Map();
  for (const entry of declaredNow) {
    if (!entry || !entry.id || !matches(entry)) continue;
    const key = entry.group || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  $('paramEmpty').hidden = groups.size > 0;

  for (const [group, entries] of groups) {
    if (group !== '' && groups.size > 1) {
      const head = document.createElement('div');
      head.className = 'grouphead';
      head.textContent = group;
      paramsBox.appendChild(head);
    }
    for (const entry of entries) paramsBox.appendChild(buildRow(entry));
  }
}

function currentValue(entry) {
  return Object.prototype.hasOwnProperty.call(vars, entry.id) ? vars[entry.id] : entry['default'];
}

// ---------------------------------------------------------------------------
// Colour — swatch, popover, conversions
// ---------------------------------------------------------------------------

function hexOf(r, g, b) {
  const two = (n) => n.toString(16).padStart(2, '0');
  return '#' + two(r) + two(g) + two(b);
}

/// #rrggbb or rgb()/rgba() into channels. The fallback alpha is what a bare
/// hex means here: the declared alpha for an untouched default, opaque for a
/// value someone chose.
function readColor(text, fallbackAlpha) {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) {
    return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16),
             b: parseInt(m[1].slice(4, 6), 16), a: fallbackAlpha };
  }
  m = /^rgba?[(]([^)]+)[)]$/.exec(t);
  if (m) {
    const parts = m[1].split(',').map((x) => parseFloat(x));
    if (parts.length >= 3 && parts.slice(0, 3).every((x) => Number.isFinite(x))) {
      return { r: Math.round(parts[0]), g: Math.round(parts[1]), b: Math.round(parts[2]),
               a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
    }
  }
  return null;
}

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: Math.round(f(5) * 255), g: Math.round(f(3) * 255), b: Math.round(f(1) * 255) };
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/// One popover for the whole page, moved under whichever swatch opened it.
/// Commits on release, like the sliders: a drag across the square is one
/// session rebuild, not one per pixel.
let cpopState = null;

function cpopColor() {
  const rgb = hsvToRgb(cpopState.h, cpopState.s, cpopState.v);
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: cpopState.hasAlpha ? cpopState.a : 1 };
}

function paintCpop() {
  const st = cpopState;
  if (!st) return;
  const hue = hsvToRgb(st.h, 1, 1);
  $('cpSv').style.backgroundColor = 'rgb(' + hue.r + ', ' + hue.g + ', ' + hue.b + ')';
  const svDot = $('cpSv').querySelector('i');
  svDot.style.left = (st.s * 100) + '%';
  svDot.style.top = ((1 - st.v) * 100) + '%';
  $('cpHue').querySelector('i').style.left = (st.h / 360 * 100) + '%';
  const c = cpopColor();
  $('cpA').querySelector('i').style.left = (st.a * 100) + '%';
  $('cpA').querySelector('b').style.background = 'linear-gradient(to right, rgba('
    + c.r + ', ' + c.g + ', ' + c.b + ', 0), rgb(' + c.r + ', ' + c.g + ', ' + c.b + '))';
}

/// The palette is the composition's own colours first — the declared colour
/// defaults — because matching an element to another element is the edit
/// actually being made. A neutral row follows.
function buildPalette(entry) {
  const box = $('cpPal');
  box.innerHTML = '';
  const seen = new Set();
  const swatches = [];
  for (const declared of declaredNow) {
    if (declared.type !== 'color' || typeof declared['default'] !== 'string') continue;
    if (seen.has(declared['default'])) continue;
    seen.add(declared['default']);
    swatches.push(declared['default']);
  }
  for (const base of ['#ffffff', '#c9c9d4', '#808080', '#000000',
                      '#5a67f2', '#2cc9e8', '#37d67a', '#ffb454', '#ff4d5e']) {
    if (!seen.has(base)) swatches.push(base);
  }
  for (const value of swatches.slice(0, 18)) {
    const c = readColor(value, 1);
    if (!c) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.style.background = value;
    button.title = value;
    button.onclick = () => {
      const hsv = rgbToHsv(c.r, c.g, c.b);
      cpopState.h = hsv.h; cpopState.s = hsv.s; cpopState.v = hsv.v;
      paintCpop();
      cpopState.commit(cpopColor());
    };
    box.appendChild(button);
  }
}

function openColorPop(anchor, entry, color, commit) {
  const pop = $('cpop');
  const hsv = rgbToHsv(color.r, color.g, color.b);
  cpopState = {
    h: hsv.h, s: hsv.s, v: hsv.v, a: color.a, commit,
    hasAlpha: typeof entry.alpha === 'number' && entry.alpha < 1,
  };
  $('cpA').hidden = !cpopState.hasAlpha;
  buildPalette(entry);
  pop.hidden = false;
  const at = anchor.getBoundingClientRect();
  const size = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(at.left, innerWidth - size.width - 8)) + 'px';
  pop.style.top = (at.bottom + size.height + 8 > innerHeight
    ? Math.max(8, at.top - size.height - 6) : at.bottom + 6) + 'px';
  paintCpop();
}

function closeColorPop() {
  $('cpop').hidden = true;
  cpopState = null;
}

function dragStrip(el, apply) {
  el.onpointerdown = (event) => {
    if (!cpopState) return;
    el.setPointerCapture(event.pointerId);
    const move = (ev) => {
      const rect = el.getBoundingClientRect();
      apply(Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
            Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)));
      paintCpop();
    };
    move(event);
    el.onpointermove = (ev) => { if (ev.buttons) move(ev); };
    el.onpointerup = () => {
      el.onpointermove = null;
      if (cpopState) cpopState.commit(cpopColor());
    };
  };
}

function buildRow(entry) {
  const row = document.createElement('div');
  row.className = 'p';

  const label = document.createElement('label');
  label.textContent = entry.label || entry.id;
  label.title = entry.description ? entry.description + '\\n(' + entry.id + ')' : entry.id;
  row.appendChild(label);

  const field = document.createElement('div');
  field.className = 'field';
  row.appendChild(field);

  const reset = document.createElement('button');
  reset.className = 'reset';
  reset.textContent = '↺';
  reset.title = 'Revenir à la valeur du code';
  reset.onclick = () => {
    if (!row.classList.contains('dirty')) return;
    delete vars[entry.id];
    pushVars();
    renderParams();
  };
  row.appendChild(reset);

  // The override is stored in the composition's own shape ("24px", rgba with
  // alpha), so the default must be compared in that shape too.
  const canonicalDefault = entry.type === 'number' && entry.suffix
    ? String(entry['default']) + entry.suffix
    : String(entry['default']);
  const markDirty = () => {
    row.classList.toggle('dirty',
      Object.prototype.hasOwnProperty.call(vars, entry.id)
      && String(vars[entry.id]) !== canonicalDefault);
  };
  const current = currentValue(entry);

  if (entry.type === 'enum' && Array.isArray(entry.options)) {
    const select = document.createElement('select');
    for (const option of entry.options) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label || option.value;
      if (option.value === current) item.selected = true;
      select.appendChild(item);
    }
    select.onchange = () => { setVar(entry.id, select.value); markDirty(); };
    field.appendChild(select);
  } else if (entry.type === 'boolean') {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = current === true || current === 'true';
    box.onchange = () => { setVar(entry.id, box.checked); markDirty(); };
    field.appendChild(box);
  } else if (entry.type === 'color') {
    // Swatch and hex together: the swatch opens the popover (square, hue,
    // alpha when declared, the composition's own palette), the hex is how a
    // colour is pasted from somewhere else. Each repaints the other.
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    const tint = document.createElement('i');
    swatch.appendChild(tint);
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.className = 'hex';
    hex.spellcheck = false;

    const shownColor = () => readColor(currentValue(entry),
      Object.prototype.hasOwnProperty.call(vars, entry.id) ? 1 : (entry.alpha ?? 1))
      ?? { r: 255, g: 255, b: 255, a: 1 };
    const paint = (c) => {
      tint.style.background = 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + c.a + ')';
      hex.value = hexOf(c.r, c.g, c.b);
    };
    paint(shownColor());

    const commit = (c) => {
      const asHex = hexOf(c.r, c.g, c.b);
      if (asHex === entry['default'] && Math.abs(c.a - (entry.alpha ?? 1)) < 0.004) {
        // Choosing the code's own colour back is not an override.
        delete vars[entry.id];
      } else {
        vars[entry.id] = c.a < 0.999
          ? 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + Math.round(c.a * 1000) / 1000 + ')'
          : asHex;
      }
      paint(c);
      markDirty();
      pushVars();
    };

    swatch.onclick = () => openColorPop(swatch, entry, shownColor(), commit);
    hex.onchange = () => {
      const parsed = readColor(hex.value.trim(), entry.alpha ?? 1);
      if (parsed) commit(parsed); else paint(shownColor());
    };
    field.append(swatch, hex);
  } else if (entry.type === 'number') {
    const range = document.createElement('input');
    range.type = 'range';
    range.min = entry.min != null ? entry.min : 0;
    range.max = entry.max != null ? entry.max : 100;
    range.step = entry.step != null ? entry.step : 1;
    const number = document.createElement('input');
    number.type = 'number';
    number.className = 'num';
    number.min = range.min;
    number.max = range.max;
    number.step = range.step;
    // parseFloat, because the stored override of a suffixed variable reads
    // "24px" and the control wants 24.
    const numeric = parseFloat(current);
    const startValue = Number.isFinite(numeric) ? numeric : Number(range.min);
    range.value = startValue;
    number.value = startValue;

    // The slider is for finding a value, the field is for stating one. Dragging
    // updates the field live and only commits on release, so a drag across a
    // range is one re-render rather than one per pixel.
    const commit = (value) => {
      const n = Number(value);
      // A suffixed declaration ("16px") gets its suffix back on the way out:
      // the composition reads the string it declared, not a bare number.
      setVar(entry.id, entry.suffix ? String(n) + entry.suffix : n);
      markDirty();
    };
    range.oninput = () => { number.value = range.value; };
    range.onchange = () => { commit(range.value); };
    number.onchange = () => { range.value = number.value; commit(number.value); };
    field.append(range, number);
    if (entry.unit) {
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = entry.unit;
      field.appendChild(unit);
    }
  } else if (entry.multiline) {
    row.classList.add('tall');
    const area = document.createElement('textarea');
    area.value = current == null ? '' : String(current);
    area.rows = 3;
    area.spellcheck = false;
    area.onchange = () => { setVar(entry.id, area.value); markDirty(); };
    field.appendChild(area);
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current == null ? '' : String(current);
    input.title = input.value;
    input.onchange = () => { setVar(entry.id, input.value); markDirty(); };
    field.appendChild(input);
  }

  markDirty();
  return row;
}

/// Applies the current override set without rebuilding the controls, so a value
/// change never steals focus from the field being edited.
async function pushVars() {
  say(L.applying);
  try {
    const data = await post('/api/save',
      { html: $('code').value, vars, ...(chosenSize() ?? {}) });
    state = data;
    say(data.width + ' × ' + data.height + ' · ' + data.fps + ' fps · '
      + (data.durationFrames || 0) + ' frames');
    reloadLive();
  } catch (error) {
    say(error.message, 'err');
  }
}

async function setVar(id, value) {
  vars[id] = value;
  await pushVars();
}

// ---------------------------------------------------------------------------
// Export, and the cache it is not
// ---------------------------------------------------------------------------

async function loadExportOptions() {
  const info = await (await fetch('/api/export')).json();
  const select = $('exFormat');
  select.innerHTML = '';
  for (const format of info.formats) {
    const option = document.createElement('option');
    option.value = format.key;
    option.textContent = format.label + ' — ' + format.detail
      + (format.available ? '' : ' (' + L.ffmpegMissing + ')');
    option.disabled = !format.available;
    select.appendChild(option);
  }
  const firstAvailable = info.formats.find((f) => f.available);
  if (firstAvailable) select.value = firstAvailable.key;
  $('exDir').value = info.defaults.directory;
  $('exName').value = info.defaults.name;
  updateQualityRow();
  if (info.running) pollExport();
}

function updateQualityRow() {
  $('exQualityRow').hidden = $('exFormat').value !== 'h264';
}

async function startExport() {
  $('exGo').disabled = true;
  $('exBar').hidden = false;
  $('exState').textContent = '';
  try {
    await post('/api/export', {
      format: $('exFormat').value,
      directory: $('exDir').value.trim(),
      name: $('exName').value.trim(),
      quality: Number($('exQuality').value),
      from: Number($('exFrom').value) || 0,
      to: Number($('exTo').value) || 0,
    });
    $('exStop').hidden = false;
    pollExport();
  } catch (error) {
    $('exState').textContent = error.message;
    $('exGo').disabled = false;
  }
}

async function pollExport() {
  let progress;
  try {
    progress = await (await fetch('/api/export')).json();
  } catch {
    $('exGo').disabled = false;
    return;
  }
  const total = progress.total || 0;
  $('exFill').style.width = total > 0 ? Math.round((progress.done / total) * 100) + '%' : '0%';
  $('exText').textContent = progress.done + (total ? ' / ' + total : '') + ' ' + L.images;

  if (progress.running) {
    setTimeout(pollExport, 500);
    return;
  }
  $('exGo').disabled = false;
  $('exStop').hidden = true;
  if (progress.error) {
    $('exState').textContent = progress.error;
  } else if (progress.done > 0) {
    $('exState').textContent = L.writtenTo + ' ' + progress.output;
  }
}

/// The destination picker. Served by the service rather than delegated to the
/// browser, because showDirectoryPicker returns a handle and the service needs
/// a path it can write to.
let browsingAt = null;

async function browse(path) {
  const query = path === null || path === undefined ? '' : '?path=' + encodeURIComponent(path);
  const data = await (await fetch('/api/browse' + query)).json();
  browsingAt = data.path;
  // The path stays editable, so a folder can be pasted in whole rather than
  // walked to one click at a time.
  $('brPath').value = data.path;
  $('brUp').disabled = !data.parent;
  $('brNote').textContent = data.error ? L.unreadable + ' (' + data.error + ')' : '';

  const shortcuts = $('brShortcuts');
  shortcuts.innerHTML = '';
  for (const entry of data.shortcuts) {
    const button = document.createElement('button');
    button.textContent = entry.label;
    button.onclick = () => browse(entry.path);
    shortcuts.appendChild(button);
  }

  const listing = $('brList');
  listing.innerHTML = '';
  if (!data.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = L.noSubfolder;
    listing.appendChild(empty);
    return;
  }
  for (const name of data.entries) {
    const button = document.createElement('button');
    button.textContent = name;
    button.onclick = () => browse(data.path + '\\\\' + name);
    listing.appendChild(button);
  }
  $('brUp').onclick = () => data.parent && browse(data.parent);
}

async function bake() {
  $('bake').disabled = true;
  $('bakeBar').hidden = false;
  $('bakeState').textContent = '';
  try {
    await post('/api/bake');
    pollBake();
  } catch (error) {
    $('bakeState').textContent = error.message;
    $('bake').disabled = false;
  }
}

function showBake(progress) {
  if (progress.directory) $('bakePath').textContent = progress.directory;
  const total = progress.total || 0;
  const done = progress.done || 0;
  const bytes = progress.bytes || 0;
  // Gio below a gigabyte reads as 0,00 — the unit follows the number.
  $('bakeSize').textContent = bytes >= 1024 * 1024 * 1024
    ? (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' Gio'
    : Math.round(bytes / (1024 * 1024)) + ' Mio';
  $('bakeBar').hidden = !progress.running;
  $('bakeFill').style.width = total > 0 ? Math.round((done / total) * 100) + '%' : '0%';
  $('bakeText').textContent = done + (total ? ' / ' + total : '') + ' ' + L.images;
  const limit = progress.limit || 0;
  $('bakeState').textContent = progress.frames + ' ' + L.images
    + (limit > 0 ? ' · ' + L.onTotal + ' ' + Math.round(limit / (1024 * 1024 * 1024)) + ' Gio' : '');
  $('bakeAuto').textContent = L.bakeAuto + ' ' + L.lossless;
  // Rebuilt only when the service reports a different set, so choosing an
  // option does not replace the menu under the cursor that just used it.
  const qualities = progress.qualities || [];
  const select = $('bakeQuality');
  if (qualities.join(',') !== select.dataset.built) {
    select.dataset.built = qualities.join(',');
    select.innerHTML = '';
    for (const name of qualities) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = L['q' + name[0].toUpperCase() + name.slice(1)] || name;
      select.appendChild(option);
    }
  }
  if (progress.quality) select.value = progress.quality;
  $('bakeClear').disabled = (progress.frames || 0) === 0;
}

async function pollBake() {
  let progress;
  try {
    progress = await (await fetch('/api/bake')).json();
  } catch {
    $('bake').disabled = false;
    return;
  }
  showBake(progress);

  if (progress.running) {
    setTimeout(pollBake, 500);
    return;
  }
  $('bake').disabled = false;
  if (progress.error) $('bakeState').textContent = L.interrupted + ' ' + progress.error;
}

async function clearBake() {
  $('bakeClear').disabled = true;
  try {
    showBake(await post('/api/bake/clear'));
  } catch (error) {
    $('bakeState').textContent = error.message;
    $('bakeClear').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const PANES = {
  code: 'codePane', params: 'paramPane', export: 'exportPane', cache: 'cachePane',
};
const TABS = {
  code: 'tabCode', params: 'tabParams', export: 'tabExport', cache: 'tabCache',
};
function showPane(which) {
  for (const [key, id] of Object.entries(PANES)) $(id).hidden = key !== which;
  for (const [key, id] of Object.entries(TABS)) $(id).classList.toggle('on', key === which);
  // The numbers go stale while the pane is hidden, and this is the only place
  // they are read from.
  if (which === 'cache') pollBake();
}
for (const [key, id] of Object.entries(TABS)) $(id).onclick = () => showPane(key);

$('collapse').onclick = () => {
  document.body.classList.add('collapsed');
  $('expand').hidden = false;
  requestAnimationFrame(fitStage);
};
$('expand').onclick = () => {
  document.body.classList.remove('collapsed');
  $('expand').hidden = true;
  requestAnimationFrame(fitStage);
};

$('tabLive').onclick = () => setMode('live');
$('tabRendu').onclick = () => setMode('rendu');

for (const button of document.querySelectorAll('.bg button')) {
  button.onclick = () => {
    $('view').className = button.dataset.bg;
    for (const other of document.querySelectorAll('.bg button')) {
      other.classList.toggle('on', other === button);
    }
  };
}

$('preset').onchange = () => {
  if ($('preset').value === 'custom') return;
  if ($('preset').value !== 'auto') {
    const [w, h] = $('preset').value.split('x');
    $('fw').value = w;
    $('fh').value = h;
  }
  apply();
};
$('fw').onchange = () => { $('preset').value = 'custom'; apply(); };
$('fh').onchange = () => { $('preset').value = 'custom'; apply(); };

$('apply').onclick = apply;
$('send').onclick = send;
$('bake').onclick = bake;
$('bakeClear').onclick = clearBake;
$('bakeQuality').onchange = async () => {
  try {
    showBake(await post('/api/bake/quality', { quality: $('bakeQuality').value }));
  } catch (error) {
    $('bakeState').textContent = error.message;
  }
};
$('exGo').onclick = startExport;
$('exStop').onclick = () => post('/api/export/cancel').catch(() => {});
$('exFormat').onchange = updateQualityRow;
function closePicker() { $('pick').hidden = true; }

/// Windows' own chooser first, the served listing only if it cannot open.
/// The fallback is not dead weight: the listing is the only thing that works
/// when the service and the browser are not on the same desktop.
$('paramSearch').oninput = renderParams;

$('exBrowse').onclick = async () => {
  const button = $('exBrowse');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = L.openedBtn;
  try {
    const data = await post('/api/browse/native', { path: $('exDir').value.trim() });
    // A null path is a cancel, and a cancel leaves the field exactly as it was.
    if (data.path) $('exDir').value = data.path;
  } catch {
    $('pick').hidden = false;
    browse($('exDir').value.trim() || null);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
};
$('brClose').onclick = closePicker;
$('brPick').onclick = () => {
  // The typed path wins over the last one listed: someone who pastes a folder
  // and presses Choisir means that folder, listed or not.
  const typed = $('brPath').value.trim();
  if (typed) $('exDir').value = typed;
  else if (browsingAt) $('exDir').value = browsingAt;
  closePicker();
};
$('brPath').onkeydown = (event) => {
  if (event.key === 'Enter') browse($('brPath').value.trim());
};
$('pick').onclick = (event) => { if (event.target === $('pick')) closePicker(); };
addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('cpop').hidden) { closeColorPop(); return; }
  if (!$('pick').hidden) closePicker();
});

dragStrip($('cpSv'), (x, y) => { cpopState.s = x; cpopState.v = 1 - y; });
dragStrip($('cpHue'), (x) => { cpopState.h = Math.min(359.9, x * 360); });
dragStrip($('cpA'), (x) => { cpopState.a = Math.round(x * 1000) / 1000; });
addEventListener('pointerdown', (event) => {
  // Click-away closes; the changes are already in, committed on each release.
  if ($('cpop').hidden) return;
  if ($('cpop').contains(event.target) || event.target.closest('.swatch')) return;
  closeColorPop();
}, true);
$('playBtn').onclick = () => setPlaying(!playing);

$('slider').oninput = () => {
  // Scrubbing pauses, in both modes, because a playhead that fights the user
  // is the thing that made this feel unpredictable.
  if (playing) setPlaying(false);
  frameNow = Number($('slider').value);
  $('fno').textContent = frameNow + ' / ' + lastFrame();
  toLive({ type: 'hf-seek', t: frameNow / fps() });
  if (mode !== 'rendu') return;
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => showFrame(frameNow), 60);
};

$('modeNote').textContent = MODE_NOTE.live;
load();
</script>`;
