// The fixture's seek implementation and machine-readable frame band.
//
// The engine's only requirement of a page is `window.__hf = { duration, seek }`
// with `duration > 0`, seeking in seconds; it polls for exactly that before it
// will capture. Everything else in a normal composition — GSAP stepping, CSS
// animation sync — is the page's business.
//
// This fixture deliberately implements that contract with pure arithmetic and
// no animation library. Its whole purpose is to isolate the variable under
// test: if a captured frame is not byte-identical to the same frame captured
// earlier, the fixture cannot be the reason, so the engine, the browser, or the
// capture mode is. A fixture animated by GSAP could not make that claim.
//
// Rules that keep it true, and that the tests enforce:
//   - no Date.now(), no performance.now(), no requestAnimationFrame loop;
//   - no Math.random();
//   - no network;
//   - every visible property is a function of the seeked time alone.
(() => {
  'use strict';

  const root = document.getElementById('composition');
  const WIDTH = Number(root.dataset.width);
  const HEIGHT = Number(root.dataset.height);
  const DURATION = Number(root.dataset.compositionDuration);
  // Not a HyperFrames attribute: the engine takes fps from the caller's capture
  // options. It lives here, namespaced, so the fixture states its own intent
  // and describe() has one place to read.
  const FPS = Number(root.dataset.netsuflowFps);

  const COUNTER_CELLS = 16;
  const BAND_HEIGHT = Math.max(Math.floor(HEIGHT / 10), 8);

  const band = document.getElementById('machine-band');
  band.width = WIDTH;
  band.height = BAND_HEIGHT;
  const bandCtx = band.getContext('2d', { alpha: true, willReadFrequently: false });
  const bandImage = bandCtx.createImageData(WIDTH, BAND_HEIGHT);

  /// Paints the frame number so a captured PNG can be identified without a
  /// human looking at it.
  ///
  /// The layout mirrors makeDiagnosticFrame() in the fake renderer and
  /// DiagnosticFrame.cpp byte for byte: sixteen cells of a binary counter, lit
  /// 255 and unlit 16, then the frame number big-endian in the red channel of
  /// the first four pixels of row 0. Reusing that convention means the readers
  /// already written for the bridge work on these captures unchanged.
  function paintBand(frame) {
    const data = bandImage.data;
    const cellWidth = Math.floor(WIDTH / COUNTER_CELLS);

    for (let cell = 0; cell < COUNTER_CELLS; cell += 1) {
      const value = ((frame >>> cell) & 1) !== 0 ? 255 : 16;
      const x0 = cell * cellWidth;
      const x1 = cell + 1 === COUNTER_CELLS ? WIDTH : x0 + cellWidth;
      for (let y = 0; y < BAND_HEIGHT; y += 1) {
        const rowStart = y * WIDTH * 4;
        for (let x = x0; x < x1; x += 1) {
          const o = rowStart + x * 4;
          data[o] = value;
          data[o + 1] = value;
          data[o + 2] = value;
          data[o + 3] = 255;
        }
      }
    }

    for (let i = 0; i < 4; i += 1) {
      data[i * 4] = (frame >>> ((3 - i) * 8)) & 0xff;
    }

    bandCtx.putImageData(bandImage, 0, 0);
  }

  // --- animated regions, each a pure function of the seeked time -------------

  const sweep = document.getElementById('sweep');
  const spinner = document.getElementById('spinner');
  const fader = document.getElementById('fader');
  const svgArc = document.getElementById('svg-arc');
  const aaTick = document.getElementById('aa-tick');
  const readout = document.getElementById('readout');
  const drawing = document.getElementById('drawing');
  drawing.width = 240;
  drawing.height = 240;
  const drawCtx = drawing.getContext('2d');

  const clips = Array.from(document.querySelectorAll('.clip'));

  /// Clip visibility from the canonical authored timing attributes
  /// (data-start, data-duration in seconds). The full HyperFrames runtime
  /// normally does this; the fixture does it itself because it does not load
  /// that runtime, and doing so exercises the same attributes.
  function applyClipVisibility(t) {
    for (const clip of clips) {
      const start = Number(clip.dataset.start);
      const duration = Number(clip.dataset.duration);
      const visible = t >= start && t < start + duration;
      clip.style.visibility = visible ? 'visible' : 'hidden';
    }
  }

  function drawCanvasRegion(progress) {
    drawCtx.clearRect(0, 0, 240, 240);
    // Hard-edged shapes only: an antialiased curve would make byte equality
    // depend on the rasteriser, which is a separate question from determinism.
    drawCtx.fillStyle = '#1e88e5';
    drawCtx.fillRect(0, 0, 240, 240);
    drawCtx.fillStyle = '#ffb300';
    const size = 40 + Math.floor(progress * 120);
    drawCtx.fillRect(20, 20, size, size);
    drawCtx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    drawCtx.fillRect(120, 140, 100, 80);
  }

  function seek(seconds) {
    // Clamp rather than throw: the engine may probe outside the range during
    // warmup, and a throwing seek would look like a broken composition.
    const t = Math.min(Math.max(Number(seconds) || 0, 0), DURATION);
    const progress = DURATION > 0 ? t / DURATION : 0;
    const frame = Math.round(t * FPS);

    paintBand(frame);
    applyClipVisibility(t);

    sweep.style.width = `${Math.round(progress * 600)}px`;
    spinner.style.transform = `rotate(${(progress * 360).toFixed(4)}deg)`;
    fader.style.opacity = (0.25 + progress * 0.75).toFixed(4);
    svgArc.setAttribute('width', String(Math.round(40 + progress * 160)));
    // Forces the antialias probe's layer to be re-rasterised every seek.
    aaTick.setAttribute('x', String(10 + Math.round(progress * 200)));
    drawCanvasRegion(progress);

    // Text content changes with the frame so the text region is not static;
    // padded so its length, and therefore its layout, never changes.
    readout.textContent = `FRAME ${String(frame).padStart(5, '0')}`;

    window.__hf.currentTime = t;
    window.__hf.currentFrame = frame;
  }

  window.__hf = {
    duration: DURATION,
    seek,
    // Not part of the engine contract; the tests and the adapter read it.
    netsuflowFixture: { width: WIDTH, height: HEIGHT, fps: FPS, version: 1 },
    currentTime: 0,
    currentFrame: 0,
  };

  // Awaited by the engine after every seek, before it captures. Two animation
  // frames is the cheapest way to be sure style and layout produced by seek()
  // have been through a paint, which matters more here than usual: Windows
  // never gets the deterministic BeginFrame capture mode, so settling is the
  // page's responsibility.
  window.__hfWaitForSeekCompletion = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

  seek(0);
})();
