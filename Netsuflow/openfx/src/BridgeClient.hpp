// Bounded loopback client used from inside the OpenFX render action.
//
// Every operation has a deadline, every allocation is bounded by the protocol
// limits, and the caller's abort signal is polled while waiting. No call may
// block indefinitely, because the thread it runs on belongs to the host.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "Protocol.hpp"
#include "SessionDescriptor.hpp"

namespace netsuflow {

enum class BridgeStatus {
  Ok,
  NotConfigured,
  ConnectFailed,
  HandshakeFailed,
  Timeout,
  Aborted,
  ProtocolError,
  ServiceError,
  Disconnected,
};

const char* describe(BridgeStatus status) noexcept;

/// Polled while the client waits. The OpenFX implementation forwards
/// `OFX::ImageEffect::abort()`.
class AbortSignal {
 public:
  virtual ~AbortSignal() = default;
  virtual bool aborted() const = 0;
};

struct FrameRequest {
  std::string binding;
  std::string sourceRevision;
  std::string pixelFormat = "RGBA8";
  std::string alphaMode = "straight";
  std::string quality = "preview";
  std::uint32_t frame = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t renderScalePpm = 1000000;
  std::uint32_t deadlineMs = 2000;
  /// Current values of the composition variables the Inspector exposes.
  /// Empty for a composition that declares none.
  std::vector<protocol::VariableValue> variables;
};

/// One variable a composition declares, as reported by DESCRIBE. Fields the
/// declaration omits arrive empty.
struct DescribedVariable {
  std::string id;
  std::string type;
  std::string label;
  std::string defaultValue;
  std::string min;
  std::string max;
  std::string step;
  std::string options;       // comma-separated for enums
  std::string optionLabels;  // comma-separated display labels, aligned with options
  std::string unit;          // display suffix for numbers ("px", "%")
};

struct FrameResponse {
  protocol::FrameMetadata metadata;
  std::vector<std::uint8_t> pixels;
};

class BridgeClient {
 public:
  BridgeClient();
  ~BridgeClient();

  BridgeClient(const BridgeClient&) = delete;
  BridgeClient& operator=(const BridgeClient&) = delete;

  /// Reads the session descriptor and opens an authenticated connection.
  /// Safe to call when already connected to the same service instance.
  ///
  /// Failures are rate-limited. Measured on Windows: refusing a loopback
  /// connection to a closed port takes ~2.1 s of SYN retransmission, so a render
  /// that retries on every frame stalls the host's render thread for its whole
  /// connect timeout, every frame, for as long as the service is down. After a
  /// failure this returns immediately with the previous error until the backoff
  /// expires, which turns "one second per frame" into "one second, once".
  BridgeStatus connect(const std::string& descriptorPath, std::uint32_t timeoutMs);

  /// Clears the failure backoff so the next connect() actually dials. Called
  /// when the user explicitly asks to reconnect.
  void resetConnectBackoff() noexcept;

  BridgeStatus requestFrame(const FrameRequest& request, FrameResponse& response,
                            const AbortSignal* abort);

  /// Asks the service what variables the binding's composition declares.
  /// Bounded like every other call; safe from the UI thread on its own client
  /// instance, which is how the Inspector uses it.
  ///
  /// `outWidth` and `outHeight` receive the size the composition is authored
  /// at, which the node needs before it can ask for a frame: requesting the
  /// host's size instead lays a portrait composition out in a landscape
  /// viewport, and it arrives cropped rather than letterboxed.
  BridgeStatus describeComposition(const std::string& binding, std::uint32_t deadlineMs,
                                   std::vector<DescribedVariable>& out,
                                   std::uint32_t* outWidth = nullptr,
                                   std::uint32_t* outHeight = nullptr,
                                   std::uint32_t* outCodeWidth = nullptr,
                                   std::uint32_t* outCodeHeight = nullptr);

  void close() noexcept;
  bool isConnected() const noexcept;

  const std::string& lastError() const noexcept { return lastError_; }
  const SessionDescriptor& session() const noexcept { return session_; }

 private:
  struct Impl;
  BridgeStatus sendMessage(protocol::MessageType type, std::uint32_t requestId,
                           const std::string& metadata, std::uint32_t deadlineMs,
                           const AbortSignal* abort);
  BridgeStatus readExact(std::uint8_t* out, std::size_t size, std::uint64_t deadlineTick,
                         const AbortSignal* abort);
  BridgeStatus readMessage(protocol::Header& header, std::string& metadata,
                           std::vector<std::uint8_t>& body, std::uint64_t deadlineTick,
                           const AbortSignal* abort);
  BridgeStatus handshake(std::uint32_t timeoutMs);
  BridgeStatus fail(BridgeStatus status, const char* reason);

  BridgeStatus connectImpl(const std::string& descriptorPath, std::uint32_t timeoutMs);

  static constexpr std::uint32_t kMinConnectBackoffMs = 250;
  static constexpr std::uint32_t kMaxConnectBackoffMs = 2000;

  Impl* impl_ = nullptr;
  std::uint64_t nextConnectAttemptTick_ = 0;
  std::uint32_t connectBackoffMs_ = 0;
  BridgeStatus lastStatus_ = BridgeStatus::Ok;
  SessionDescriptor session_;
  std::string instanceId_;
  std::string lastError_;
  std::uint32_t nextRequestId_ = 1;
  bool connected_ = false;
};

}  // namespace netsuflow
