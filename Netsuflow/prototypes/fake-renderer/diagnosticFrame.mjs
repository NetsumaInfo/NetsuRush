// JavaScript mirror of openfx/src/DiagnosticFrame.cpp.
//
// Both implementations must produce byte-identical output for the same spec.
// That equality is what proves, in T03, that pixels crossed the bridge unchanged
// without Remotion being involved at all. `diagnosticFrame.test.mjs` pins the
// arithmetic; the end-to-end test compares the two implementations directly.

export const MAX_FRAME_DIMENSION = 16384;
export const BYTES_PER_PIXEL = 4;
export const NO_FRAME_MARKER = 0xffffffff;

const PATTERN_FRAME_MASK = 0x00ffffff;
const COUNTER_CELLS = 16;

export function isValidFrameSpec({ width, height }) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_FRAME_DIMENSION &&
    height <= MAX_FRAME_DIMENSION
  );
}

export function diagnosticFrameByteSize(spec) {
  if (!isValidFrameSpec(spec)) return 0;
  return spec.width * spec.height * BYTES_PER_PIXEL;
}

function counterBandHeight(height) {
  const tenth = Math.floor(height / 10);
  const band = tenth > 8 ? tenth : 8;
  return band < height ? band : height;
}

export function makeDiagnosticFrame({ width, height, frame }) {
  const spec = { width, height, frame };
  const size = diagnosticFrameByteSize(spec);
  if (size === 0) return null;

  const pixels = Buffer.allocUnsafe(size);
  const f = frame & PATTERN_FRAME_MASK;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * BYTES_PER_PIXEL;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + x * BYTES_PER_PIXEL;
      pixels[offset] = (x * 7 + f * 13) & 0xff;
      pixels[offset + 1] = (y * 11 + f * 29) & 0xff;
      pixels[offset + 2] = ((x ^ y) + f * 3) & 0xff;
      pixels[offset + 3] = 255;
    }
  }

  // Visible binary frame counter across the top band.
  const band = counterBandHeight(height);
  const cellWidth = Math.floor(width / COUNTER_CELLS);
  if (cellWidth > 0) {
    for (let cell = 0; cell < COUNTER_CELLS; cell += 1) {
      const lit = ((frame >>> cell) & 1) !== 0;
      const value = lit ? 255 : 16;
      const x0 = cell * cellWidth;
      const x1 = cell + 1 === COUNTER_CELLS ? width : x0 + cellWidth;
      for (let y = 0; y < band; y += 1) {
        const rowStart = y * width * BYTES_PER_PIXEL;
        for (let x = x0; x < x1; x += 1) {
          const offset = rowStart + x * BYTES_PER_PIXEL;
          pixels[offset] = value;
          pixels[offset + 1] = value;
          pixels[offset + 2] = value;
          pixels[offset + 3] = 255;
        }
      }
    }
  }

  // Machine-readable frame marker in the red channel of the first four pixels.
  if (width >= 4) {
    for (let i = 0; i < 4; i += 1) {
      const shift = (3 - i) * 8;
      pixels[i * BYTES_PER_PIXEL] = (frame >>> shift) & 0xff;
    }
  }

  return pixels;
}

export function frameMarker(pixels, spec) {
  if (!pixels || spec.width < 4) return NO_FRAME_MARKER;
  const size = diagnosticFrameByteSize(spec);
  if (size === 0 || pixels.length < size) return NO_FRAME_MARKER;
  let value = 0;
  for (let i = 0; i < 4; i += 1) {
    value = ((value << 8) | pixels[i * BYTES_PER_PIXEL]) >>> 0;
  }
  return value;
}
