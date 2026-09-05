#include "SessionDescriptor.hpp"

#include <cstdio>
#include <cstdlib>
#include <vector>

#include "MiniJson.hpp"
#include "Protocol.hpp"

namespace netsuflow {
namespace {

bool isPrintableAscii(const std::string& value) noexcept {
  for (const char raw : value) {
    const unsigned char ch = static_cast<unsigned char>(raw);
    if (ch < 0x21 || ch > 0x7E) return false;
  }
  return true;
}

std::string environmentValue(const char* name) {
#if defined(_WIN32)
  char* buffer = nullptr;
  std::size_t length = 0;
  if (_dupenv_s(&buffer, &length, name) != 0 || buffer == nullptr) return std::string();
  std::string value(buffer);
  std::free(buffer);
  return value;
#else
  const char* value = std::getenv(name);
  return value != nullptr ? std::string(value) : std::string();
#endif
}

}  // namespace

const char* describe(SessionStatus status) noexcept {
  switch (status) {
    case SessionStatus::Ok: return "ok";
    case SessionStatus::NotFound: return "session descriptor not found";
    case SessionStatus::Unreadable: return "session descriptor unreadable";
    case SessionStatus::TooLarge: return "session descriptor too large";
    case SessionStatus::Malformed: return "session descriptor malformed";
    case SessionStatus::MissingField: return "session descriptor missing a required field";
    case SessionStatus::UnsupportedVersion: return "session descriptor protocol version unsupported";
    case SessionStatus::InvalidPort: return "session descriptor port invalid";
    case SessionStatus::InvalidToken: return "session descriptor token invalid";
  }
  return "unknown session status";
}

SessionStatus parseSessionDescriptor(const char* data, std::size_t size, SessionDescriptor& out) {
  if (data == nullptr) return SessionStatus::Malformed;
  if (size > kMaxSessionDescriptorBytes) return SessionStatus::TooLarge;

  json::Object document;
  const char* error = nullptr;
  if (!json::parseFlatObject(data, size, document, &error)) return SessionStatus::Malformed;

  SessionDescriptor parsed;
  std::uint32_t port = 0;
  if (!document.getUint32("protocolVersion", parsed.protocolVersion) ||
      !document.getString("instanceId", parsed.instanceId) ||
      !document.getUint64("pid", parsed.pid) || !document.getUint32("port", port) ||
      !document.getString("token", parsed.token)) {
    return SessionStatus::MissingField;
  }
  document.getString("startedAt", parsed.startedAt);

  // Optional, and range-checked like the required one: a descriptor that names
  // a nonsense editor port is treated as naming none, never as a port to open.
  std::uint32_t editorPort = 0;
  if (document.getUint32("editorPort", editorPort) && editorPort > 0 && editorPort <= 65535) {
    parsed.editorPort = static_cast<std::uint16_t>(editorPort);
  }

  if (parsed.protocolVersion != protocol::kVersion) return SessionStatus::UnsupportedVersion;
  if (port == 0 || port > 65535) return SessionStatus::InvalidPort;
  if (parsed.token.size() < kMinTokenChars || parsed.token.size() > kMaxTokenChars ||
      !isPrintableAscii(parsed.token)) {
    return SessionStatus::InvalidToken;
  }
  if (parsed.instanceId.empty() || parsed.instanceId.size() > 128) {
    return SessionStatus::MissingField;
  }

  parsed.port = static_cast<std::uint16_t>(port);
  out = parsed;
  return SessionStatus::Ok;
}

SessionStatus loadSessionDescriptor(const std::string& path, SessionDescriptor& out) {
  if (path.empty()) return SessionStatus::NotFound;

  std::FILE* file = nullptr;
#if defined(_WIN32)
  if (fopen_s(&file, path.c_str(), "rb") != 0) file = nullptr;
#else
  file = std::fopen(path.c_str(), "rb");
#endif
  if (file == nullptr) return SessionStatus::NotFound;

  std::vector<char> buffer(kMaxSessionDescriptorBytes + 1);
  const std::size_t read = std::fread(buffer.data(), 1, buffer.size(), file);
  const bool failed = std::ferror(file) != 0;
  std::fclose(file);

  if (failed) return SessionStatus::Unreadable;
  if (read > kMaxSessionDescriptorBytes) return SessionStatus::TooLarge;
  return parseSessionDescriptor(buffer.data(), read, out);
}

std::string defaultSessionDescriptorPath() {
  const std::string override = environmentValue("NETSUFLOW_SESSION_FILE");
  if (!override.empty()) return override;

#if defined(_WIN32)
  const std::string base = environmentValue("LOCALAPPDATA");
  if (base.empty()) return std::string();
  return base + "\\NetsuRush\\netsuflow\\session.json";
#elif defined(__APPLE__)
  const std::string home = environmentValue("HOME");
  if (home.empty()) return std::string();
  return home + "/Library/Application Support/NetsuRush/netsuflow/session.json";
#else
  const std::string home = environmentValue("HOME");
  if (home.empty()) return std::string();
  return home + "/.local/share/NetsuRush/netsuflow/session.json";
#endif
}

}  // namespace netsuflow
