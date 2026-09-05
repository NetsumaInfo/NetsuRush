// Discovery of the NetsuRush renderer service.
//
// The plugin cannot know the core's dynamic port, so the application writes an
// atomic per-user descriptor and the plugin reads it. The descriptor is treated
// as untrusted input: it is bounded, strictly validated, and never used to open
// anything other than a loopback TCP connection.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace netsuflow {

struct SessionDescriptor {
  std::uint32_t protocolVersion = 0;
  std::string instanceId;
  std::uint64_t pid = 0;
  std::uint16_t port = 0;
  std::string token;
  std::string startedAt;
  /// Loopback port of the composition editor, or 0 when the service does not
  /// serve one. Optional on purpose: a descriptor written by an older service,
  /// or by one started without the editor, must still parse.
  std::uint16_t editorPort = 0;
};

enum class SessionStatus {
  Ok,
  NotFound,
  Unreadable,
  TooLarge,
  Malformed,
  MissingField,
  UnsupportedVersion,
  InvalidPort,
  InvalidToken,
};

const char* describe(SessionStatus status) noexcept;

inline constexpr std::size_t kMaxSessionDescriptorBytes = 8192;
inline constexpr std::size_t kMinTokenChars = 32;
inline constexpr std::size_t kMaxTokenChars = 512;

SessionStatus parseSessionDescriptor(const char* data, std::size_t size, SessionDescriptor& out);
SessionStatus loadSessionDescriptor(const std::string& path, SessionDescriptor& out);

/// `NETSUFLOW_SESSION_FILE` overrides the location, which is how the tests and
/// the fake renderer point the plugin at a throwaway descriptor.
std::string defaultSessionDescriptorPath();

}  // namespace netsuflow
