#include "DiagnosticFrame.hpp"

#include <cstring>
#include <limits>

#include "MicroTest.hpp"

using namespace netsuflow;

TEST_CASE("diagnostic frame encodes requested frame") {
  FrameSpec spec{64, 32, 42};
  const auto pixels = makeDiagnosticFrame(spec);
  REQUIRE(pixels.size() == 64U * 32U * 4U);
  REQUIRE(frameMarker(pixels, spec) == 42);
}

TEST_CASE("frame marker round trips across the uint32 range") {
  const std::uint32_t frames[] = {0u, 1u, 255u, 256u, 65535u, 16777215u, 4294967294u};
  for (const std::uint32_t frame : frames) {
    FrameSpec spec{16, 16, frame};
    const auto pixels = makeDiagnosticFrame(spec);
    REQUIRE(!pixels.empty());
    REQUIRE(frameMarker(pixels, spec) == frame);
  }
}

TEST_CASE("frames differ when only the frame number differs") {
  const auto a = makeDiagnosticFrame(FrameSpec{32, 32, 10});
  const auto b = makeDiagnosticFrame(FrameSpec{32, 32, 11});
  REQUIRE(a.size() == b.size());
  REQUIRE(std::memcmp(a.data(), b.data(), a.size()) != 0);
}

TEST_CASE("generation is deterministic") {
  const auto first = makeDiagnosticFrame(FrameSpec{97, 61, 12345});
  const auto second = makeDiagnosticFrame(FrameSpec{97, 61, 12345});
  REQUIRE(first.size() == second.size());
  REQUIRE(std::memcmp(first.data(), second.data(), first.size()) == 0);
}

TEST_CASE("invalid specs produce no pixels") {
  REQUIRE(makeDiagnosticFrame(FrameSpec{0, 32, 1}).empty());
  REQUIRE(makeDiagnosticFrame(FrameSpec{32, 0, 1}).empty());
  REQUIRE(makeDiagnosticFrame(FrameSpec{kMaxFrameDimension + 1, 32, 1}).empty());
  REQUIRE(makeDiagnosticFrame(FrameSpec{32, kMaxFrameDimension + 1, 1}).empty());
  REQUIRE(diagnosticFrameByteSize(FrameSpec{0, 0, 0}) == 0);
}

TEST_CASE("byte size of the largest allowed frame does not overflow") {
  const FrameSpec spec{kMaxFrameDimension, kMaxFrameDimension, 0};
  const std::size_t size = diagnosticFrameByteSize(spec);
  // 16384 * 16384 * 4 is exactly 2^32, so a 32-bit size_t must refuse the spec
  // rather than wrap it to zero and hand back a plausible-looking allocation.
  constexpr bool kWideSizeType = sizeof(std::size_t) >= 8;
  const std::size_t expected =
      kWideSizeType ? static_cast<std::size_t>(16384ull * 16384ull * 4ull) : std::size_t{0};
  REQUIRE(size == expected);
}

TEST_CASE("writing refuses a buffer that is too small") {
  const FrameSpec spec{8, 8, 3};
  std::vector<std::uint8_t> buffer(diagnosticFrameByteSize(spec) - 1, 0xAB);
  REQUIRE(!writeDiagnosticFrame(spec, buffer.data(), buffer.size()));
  for (const std::uint8_t byte : buffer) {
    REQUIRE(byte == 0xAB);  // buffer left untouched
  }
  REQUIRE(!writeDiagnosticFrame(spec, nullptr, 1024));
}

TEST_CASE("alpha is fully opaque across the frame") {
  const FrameSpec spec{40, 24, 7};
  const auto pixels = makeDiagnosticFrame(spec);
  for (std::size_t offset = 3; offset < pixels.size(); offset += 4) {
    REQUIRE(pixels[offset] == 255);
  }
}

TEST_CASE("frame marker reports the sentinel for narrow frames") {
  const FrameSpec spec{3, 3, 9};
  const auto pixels = makeDiagnosticFrame(spec);
  REQUIRE(!pixels.empty());
  REQUIRE(frameMarker(pixels, spec) == kNoFrameMarker);
}

// Literal golden values, mirrored byte for byte in the fake renderer's
// diagnosticFrame.test.mjs. Together the two suites pin the shared pixel
// contract independently, so a drift on either side names its own culprit.
TEST_CASE("golden pixels") {
  const FrameSpec spec{64, 40, 5};
  const auto pixels = makeDiagnosticFrame(spec);
  REQUIRE(!pixels.empty());

  const auto at = [&pixels](std::uint32_t x, std::uint32_t y, int channel) {
    return pixels[(static_cast<std::size_t>(y) * 64u + x) * 4u + static_cast<std::size_t>(channel)];
  };

  // Counter band, frame 5 == 0b101: cells 0 and 2 lit, cell 1 dark.
  // The first four red channels of row 0 carry the big-endian frame marker.
  REQUIRE(at(0, 0, 0) == 0);
  REQUIRE(at(0, 0, 1) == 255);
  REQUIRE(at(3, 0, 0) == 5);
  REQUIRE(at(3, 0, 1) == 255);
  REQUIRE(at(5, 0, 0) == 16);
  REQUIRE(at(5, 0, 1) == 16);
  REQUIRE(at(9, 0, 0) == 255);

  // Pattern area below the band.
  REQUIRE(at(5, 30, 0) == 100);
  REQUIRE(at(5, 30, 1) == 219);
  REQUIRE(at(5, 30, 2) == 42);
  REQUIRE(at(5, 30, 3) == 255);
}

TEST_CASE("frame marker refuses a buffer shorter than the spec") {
  const FrameSpec spec{16, 16, 5};
  std::vector<std::uint8_t> shortBuffer(10, 0);
  REQUIRE(frameMarker(shortBuffer, spec) == kNoFrameMarker);
  REQUIRE(frameMarker(nullptr, 0, spec) == kNoFrameMarker);
}

MICROTEST_MAIN()
