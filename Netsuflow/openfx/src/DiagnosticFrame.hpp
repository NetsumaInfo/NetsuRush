// Deterministic RGBA8 test frame shared by the plugin and the fake renderer.
//
// The C++ and JavaScript implementations must produce byte-identical output for
// the same FrameSpec. That equality is what lets T03 prove pixels survived the
// bridge unaltered without involving a real rendering engine.
//
// Buffer layout is top-down: row 0 is the top row of the image, rows are tightly
// packed, channel order is R, G, B, A.
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace netsuflow {

struct FrameSpec {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t frame = 0;
};

inline constexpr std::uint32_t kMaxFrameDimension = 16384;
inline constexpr std::uint32_t kBytesPerPixelRgba8 = 4;

/// Sentinel returned by frameMarker() when the frame number cannot be encoded.
inline constexpr std::uint32_t kNoFrameMarker = 0xFFFFFFFFu;

bool isValidFrameSpec(const FrameSpec& spec) noexcept;

/// Tightly packed byte size, or 0 when the spec is invalid or would overflow.
std::size_t diagnosticFrameByteSize(const FrameSpec& spec) noexcept;

/// Writes the frame into `dest`. Returns false without touching `dest` when the
/// spec is invalid or the buffer is too small.
bool writeDiagnosticFrame(const FrameSpec& spec, std::uint8_t* dest, std::size_t destSize) noexcept;

/// Convenience allocation wrapper. Returns an empty vector for an invalid spec.
std::vector<std::uint8_t> makeDiagnosticFrame(const FrameSpec& spec);

/// Reads back the frame number encoded in the first four pixels of row 0.
std::uint32_t frameMarker(const std::uint8_t* pixels, std::size_t size, const FrameSpec& spec) noexcept;
std::uint32_t frameMarker(const std::vector<std::uint8_t>& pixels, const FrameSpec& spec) noexcept;

}  // namespace netsuflow
