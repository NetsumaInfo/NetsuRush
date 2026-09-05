// Command-line driver for BridgeClient, used by the Node end-to-end test.
//
// It exists so the native client can be exercised against a real socket and a
// real hostile server outside DaVinci Resolve. Everything it proves is a
// prerequisite for T03; none of it replaces the in-host manual matrix.
//
// Usage: BridgeClientHarness <session-file> <command> [args...]
//
// Commands
//   frame <w> <h> <frame>        one frame, pixels compared against the local fixture
//   sequence <w> <h> <count>     frames 0..count-1, each compared, timings reported
//   repeat <w> <h> <frame> <n>   the same frame n times: measures a cache hit
//   soak <w> <h> <count>         pseudo-random frames, each compared
//   abort <w> <h> <frame>        abort signal raised before the request
//   expect-error <w> <h> <frame> a non-Ok outcome is the pass condition
//   reconnect <w> <h> <frame>    request, drop, reconnect, request again
//
// Output is key=value lines on stdout. Exit code 0 means the command's own pass
// condition held.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "BridgeClient.hpp"
#include "DiagnosticFrame.hpp"

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <psapi.h>
#endif

using namespace netsuflow;

namespace {

/// Peak/current working set in KiB, or 0 where unavailable. Used to show that a
/// long soak does not grow without bound.
std::size_t workingSetKb() {
#if defined(_WIN32)
  PROCESS_MEMORY_COUNTERS counters;
  if (::GetProcessMemoryInfo(::GetCurrentProcess(), &counters, sizeof(counters))) {
    return static_cast<std::size_t>(counters.WorkingSetSize / 1024);
  }
#endif
  return 0;
}

std::size_t handleCount() {
#if defined(_WIN32)
  DWORD handles = 0;
  if (::GetProcessHandleCount(::GetCurrentProcess(), &handles)) {
    return static_cast<std::size_t>(handles);
  }
#endif
  return 0;
}

constexpr std::uint32_t kConnectTimeoutMs = 3000;
constexpr std::uint32_t kRequestTimeoutMs = 5000;

class NeverAborts : public AbortSignal {
 public:
  bool aborted() const override { return false; }
};

class AlwaysAborts : public AbortSignal {
 public:
  bool aborted() const override { return true; }
};

const char* statusName(BridgeStatus status) {
  switch (status) {
    case BridgeStatus::Ok: return "Ok";
    case BridgeStatus::NotConfigured: return "NotConfigured";
    case BridgeStatus::ConnectFailed: return "ConnectFailed";
    case BridgeStatus::HandshakeFailed: return "HandshakeFailed";
    case BridgeStatus::Timeout: return "Timeout";
    case BridgeStatus::Aborted: return "Aborted";
    case BridgeStatus::ProtocolError: return "ProtocolError";
    case BridgeStatus::ServiceError: return "ServiceError";
    case BridgeStatus::Disconnected: return "Disconnected";
  }
  return "Unknown";
}

double percentile(std::vector<double> samples, double fraction) {
  if (samples.empty()) return 0.0;
  std::sort(samples.begin(), samples.end());
  std::size_t index = static_cast<std::size_t>(fraction * static_cast<double>(samples.size()));
  if (index >= samples.size()) index = samples.size() - 1;
  return samples[index];
}

FrameRequest makeRequest(std::uint32_t width, std::uint32_t height, std::uint32_t frame) {
  FrameRequest request;
  request.binding = "harness";
  request.sourceRevision = "rev-0";
  request.frame = frame;
  request.width = width;
  request.height = height;
  request.deadlineMs = kRequestTimeoutMs;
  return request;
}

/// Compares returned pixels against the locally generated fixture, honouring the
/// stride the service declared.
bool pixelsMatchFixture(const FrameResponse& response, std::uint32_t width, std::uint32_t height,
                        std::uint32_t frame) {
  const FrameSpec spec{width, height, frame};
  const std::vector<std::uint8_t> expected = makeDiagnosticFrame(spec);
  if (expected.empty()) return false;

  const std::size_t rowBytes = static_cast<std::size_t>(width) * 4u;
  for (std::uint32_t y = 0; y < height; ++y) {
    const std::size_t sourceOffset = static_cast<std::size_t>(y) * response.metadata.stride;
    if (sourceOffset + rowBytes > response.pixels.size()) return false;
    if (std::memcmp(response.pixels.data() + sourceOffset, expected.data() + y * rowBytes,
                    rowBytes) != 0) {
      return false;
    }
  }
  return true;
}

std::uint32_t parseU32(const char* text) {
  return static_cast<std::uint32_t>(std::strtoul(text, nullptr, 10));
}

int usage() {
  std::fprintf(stderr, "usage: BridgeClientHarness <session-file> <command> [args...]\n");
  return 2;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) return usage();

  const std::string sessionFile = argv[1];
  const std::string command = argv[2];

  BridgeClient client;
  NeverAborts neverAborts;
  AlwaysAborts alwaysAborts;

  if (command == "retry-storm") {
    // Requests `count` frames without stopping at failures, and reports the total
    // wall clock. With a dead service this is the measurement that says whether
    // the connect backoff works: without it the cost is count * connectTimeout.
    if (argc < 6) return usage();
    const std::uint32_t width = parseU32(argv[3]);
    const std::uint32_t height = parseU32(argv[4]);
    const std::uint32_t count = parseU32(argv[5]);

    const auto start = std::chrono::steady_clock::now();
    std::uint32_t ok = 0;
    for (std::uint32_t i = 0; i < count; ++i) {
      client.connect(sessionFile, 1000);
      FrameResponse response;
      if (client.requestFrame(makeRequest(width, height, i), response, &neverAborts) ==
          BridgeStatus::Ok) {
        ++ok;
      }
    }
    const double elapsed =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::printf("attempts=%u\n", count);
    std::printf("succeeded=%u\n", ok);
    std::printf("totalMs=%.0f\n", elapsed);
    return 0;
  }

  const BridgeStatus connectStatus = client.connect(sessionFile, kConnectTimeoutMs);
  std::printf("connect=%s\n", statusName(connectStatus));
  if (connectStatus != BridgeStatus::Ok) {
    std::printf("error=%s\n", client.lastError().c_str());
    // A connection failure is the expected result for some scenarios; the Node
    // side decides, so report it and exit non-zero.
    return 1;
  }

  if (command == "frame" || command == "expect-error" || command == "abort") {
    if (argc < 6) return usage();
    const std::uint32_t width = parseU32(argv[3]);
    const std::uint32_t height = parseU32(argv[4]);
    const std::uint32_t frame = parseU32(argv[5]);

    FrameResponse response;
    const AbortSignal& signal =
        command == "abort" ? static_cast<const AbortSignal&>(alwaysAborts)
                           : static_cast<const AbortSignal&>(neverAborts);
    const BridgeStatus status = client.requestFrame(makeRequest(width, height, frame), response,
                                                    &signal);
    std::printf("status=%s\n", statusName(status));
    std::printf("error=%s\n", client.lastError().c_str());
    std::printf("bytes=%zu\n", response.pixels.size());

    if (command == "expect-error") return status == BridgeStatus::Ok ? 1 : 0;
    if (command == "abort") return status == BridgeStatus::Aborted ? 0 : 1;

    if (status != BridgeStatus::Ok) return 1;
    const bool matches = pixelsMatchFixture(response, width, height, frame);
    std::printf("pixelsMatch=%s\n", matches ? "true" : "false");
    return matches ? 0 : 1;
  }

  if (command == "sequence" || command == "soak" || command == "repeat") {
    // repeat takes an extra argument: <w> <h> <frame> <count>
    const bool isRepeat = command == "repeat";
    if (argc < (isRepeat ? 7 : 6)) return usage();
    const std::uint32_t width = parseU32(argv[3]);
    const std::uint32_t height = parseU32(argv[4]);
    const std::uint32_t fixedFrame = isRepeat ? parseU32(argv[5]) : 0;
    const std::uint32_t count = parseU32(argv[isRepeat ? 6 : 5]);

    const std::size_t rssStart = workingSetKb();
    const std::size_t handlesStart = handleCount();

    std::vector<double> timings;
    timings.reserve(count);
    std::uint32_t mismatches = 0;
    std::uint32_t failures = 0;
    std::uint32_t state = 0x12345678u;

    for (std::uint32_t i = 0; i < count; ++i) {
      // Deterministic pseudo-random walk for the soak variant, so a failing run
      // can be replayed exactly.
      state = state * 1664525u + 1013904223u;
      const std::uint32_t frame =
          isRepeat ? fixedFrame : (command == "soak" ? (state >> 8) % 4096u : i);

      const auto start = std::chrono::steady_clock::now();
      FrameResponse response;
      const BridgeStatus status =
          client.requestFrame(makeRequest(width, height, frame), response, &neverAborts);
      const auto end = std::chrono::steady_clock::now();

      if (status != BridgeStatus::Ok) {
        ++failures;
        std::printf("failure frame=%u status=%s error=%s\n", frame, statusName(status),
                    client.lastError().c_str());
        break;
      }
      if (!pixelsMatchFixture(response, width, height, frame)) {
        ++mismatches;
        std::printf("mismatch frame=%u\n", frame);
        break;
      }
      timings.push_back(std::chrono::duration<double, std::milli>(end - start).count());
    }

    std::printf("completed=%zu\n", timings.size());
    std::printf("failures=%u\n", failures);
    std::printf("mismatches=%u\n", mismatches);
    std::printf("p50=%.3f\n", percentile(timings, 0.50));
    std::printf("p95=%.3f\n", percentile(timings, 0.95));
    std::printf("p99=%.3f\n", percentile(timings, 0.99));
    std::printf("rssStartKb=%zu\n", rssStart);
    std::printf("rssEndKb=%zu\n", workingSetKb());
    std::printf("handlesStart=%zu\n", handlesStart);
    std::printf("handlesEnd=%zu\n", handleCount());
    return (failures == 0 && mismatches == 0 && timings.size() == count) ? 0 : 1;
  }

  if (command == "reconnect") {
    if (argc < 6) return usage();
    const std::uint32_t width = parseU32(argv[3]);
    const std::uint32_t height = parseU32(argv[4]);
    const std::uint32_t frame = parseU32(argv[5]);

    FrameResponse first;
    const BridgeStatus firstStatus =
        client.requestFrame(makeRequest(width, height, frame), first, &neverAborts);
    std::printf("first=%s\n", statusName(firstStatus));

    client.close();
    const BridgeStatus reconnectStatus = client.connect(sessionFile, kConnectTimeoutMs);
    std::printf("reconnect=%s\n", statusName(reconnectStatus));
    if (reconnectStatus != BridgeStatus::Ok) return 1;

    FrameResponse second;
    const BridgeStatus secondStatus =
        client.requestFrame(makeRequest(width, height, frame), second, &neverAborts);
    std::printf("second=%s\n", statusName(secondStatus));
    if (firstStatus != BridgeStatus::Ok || secondStatus != BridgeStatus::Ok) return 1;
    return pixelsMatchFixture(second, width, height, frame) ? 0 : 1;
  }

  std::fprintf(stderr, "unknown command: %s\n", command.c_str());
  return usage();
}
