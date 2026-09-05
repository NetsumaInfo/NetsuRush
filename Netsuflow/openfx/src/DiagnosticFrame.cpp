#include "DiagnosticFrame.hpp"

#include <limits>

namespace netsuflow {
namespace {

// Frame is masked to 24 bits inside the pattern so the same arithmetic is exact
// in IEEE-754 doubles, which is what the JavaScript mirror uses.
constexpr std::uint32_t kPatternFrameMask = 0x00FFFFFFu;

constexpr std::uint32_t kCounterCells = 16;

inline void patternPixel(std::uint32_t x, std::uint32_t y, std::uint32_t frame,
                         std::uint8_t* out) noexcept {
  const std::uint32_t f = frame & kPatternFrameMask;
  out[0] = static_cast<std::uint8_t>((x * 7u + f * 13u) & 0xFFu);
  out[1] = static_cast<std::uint8_t>((y * 11u + f * 29u) & 0xFFu);
  out[2] = static_cast<std::uint8_t>(((x ^ y) + f * 3u) & 0xFFu);
  out[3] = 255u;
}

inline std::uint32_t counterBandHeight(std::uint32_t height) noexcept {
  const std::uint32_t tenth = height / 10u;
  const std::uint32_t band = tenth > 8u ? tenth : 8u;
  return band < height ? band : height;
}

}  // namespace

bool isValidFrameSpec(const FrameSpec& spec) noexcept {
  return spec.width > 0 && spec.height > 0 && spec.width <= kMaxFrameDimension &&
         spec.height <= kMaxFrameDimension;
}

std::size_t diagnosticFrameByteSize(const FrameSpec& spec) noexcept {
  if (!isValidFrameSpec(spec)) return 0;
  const std::uint64_t bytes = static_cast<std::uint64_t>(spec.width) *
                              static_cast<std::uint64_t>(spec.height) *
                              static_cast<std::uint64_t>(kBytesPerPixelRgba8);
  if (bytes > static_cast<std::uint64_t>((std::numeric_limits<std::size_t>::max)())) return 0;
  return static_cast<std::size_t>(bytes);
}

bool writeDiagnosticFrame(const FrameSpec& spec, std::uint8_t* dest,
                          std::size_t destSize) noexcept {
  const std::size_t needed = diagnosticFrameByteSize(spec);
  if (needed == 0 || dest == nullptr || destSize < needed) return false;

  for (std::uint32_t y = 0; y < spec.height; ++y) {
    std::uint8_t* row = dest + static_cast<std::size_t>(y) * spec.width * kBytesPerPixelRgba8;
    for (std::uint32_t x = 0; x < spec.width; ++x) {
      patternPixel(x, y, spec.frame, row + static_cast<std::size_t>(x) * kBytesPerPixelRgba8);
    }
  }

  // Visible binary frame counter across the top band: cell i is lit when bit i
  // of the low 16 bits of the frame number is set. Readable by eye in Fusion,
  // which is what T01 needs from a generator that cannot rasterize text.
  const std::uint32_t band = counterBandHeight(spec.height);
  const std::uint32_t cellWidth = spec.width / kCounterCells;
  if (cellWidth > 0) {
    for (std::uint32_t cell = 0; cell < kCounterCells; ++cell) {
      const bool lit = ((spec.frame >> cell) & 1u) != 0u;
      const std::uint8_t value = lit ? 255u : 16u;
      const std::uint32_t x0 = cell * cellWidth;
      const std::uint32_t x1 = (cell + 1 == kCounterCells) ? spec.width : x0 + cellWidth;
      for (std::uint32_t y = 0; y < band; ++y) {
        std::uint8_t* row = dest + static_cast<std::size_t>(y) * spec.width * kBytesPerPixelRgba8;
        for (std::uint32_t x = x0; x < x1; ++x) {
          std::uint8_t* px = row + static_cast<std::size_t>(x) * kBytesPerPixelRgba8;
          px[0] = value;
          px[1] = value;
          px[2] = value;
          px[3] = 255u;
        }
      }
    }
  }

  // Machine-readable frame marker: big-endian frame number in the red channel of
  // the first four pixels of row 0.
  if (spec.width >= 4) {
    for (std::uint32_t i = 0; i < 4; ++i) {
      const std::uint32_t shift = (3u - i) * 8u;
      dest[static_cast<std::size_t>(i) * kBytesPerPixelRgba8] =
          static_cast<std::uint8_t>((spec.frame >> shift) & 0xFFu);
    }
  }

  return true;
}

std::vector<std::uint8_t> makeDiagnosticFrame(const FrameSpec& spec) {
  const std::size_t needed = diagnosticFrameByteSize(spec);
  if (needed == 0) return {};
  std::vector<std::uint8_t> pixels(needed);
  if (!writeDiagnosticFrame(spec, pixels.data(), pixels.size())) return {};
  return pixels;
}

std::uint32_t frameMarker(const std::uint8_t* pixels, std::size_t size,
                          const FrameSpec& spec) noexcept {
  if (pixels == nullptr || spec.width < 4) return kNoFrameMarker;
  const std::size_t needed = diagnosticFrameByteSize(spec);
  if (needed == 0 || size < needed) return kNoFrameMarker;
  std::uint32_t value = 0;
  for (std::uint32_t i = 0; i < 4; ++i) {
    value = (value << 8) | pixels[static_cast<std::size_t>(i) * kBytesPerPixelRgba8];
  }
  return value;
}

std::uint32_t frameMarker(const std::vector<std::uint8_t>& pixels,
                          const FrameSpec& spec) noexcept {
  return frameMarker(pixels.data(), pixels.size(), spec);
}

}  // namespace netsuflow
