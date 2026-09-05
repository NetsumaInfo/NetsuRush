#include "SessionDescriptor.hpp"

#include <cstring>
#include <string>

#include "MicroTest.hpp"

using namespace netsuflow;

namespace {

const char* kToken = "0123456789abcdef0123456789abcdef";  // 32 chars, minimum length

std::string descriptor(const char* token, unsigned version, unsigned port) {
  return std::string("{\"protocolVersion\":") + std::to_string(version) +
         ",\"instanceId\":\"abc-123\",\"pid\":4242,\"port\":" + std::to_string(port) +
         ",\"token\":\"" + token + "\",\"startedAt\":\"2026-08-26T12:00:00Z\"}";
}

SessionStatus parse(const std::string& document, SessionDescriptor& out) {
  return parseSessionDescriptor(document.data(), document.size(), out);
}

}  // namespace

TEST_CASE("a well formed descriptor parses") {
  SessionDescriptor session;
  REQUIRE(parse(descriptor(kToken, 1, 8734), session) == SessionStatus::Ok);
  REQUIRE(session.protocolVersion == 1);
  REQUIRE(session.instanceId == "abc-123");
  REQUIRE(session.pid == 4242);
  REQUIRE(session.port == 8734);
  REQUIRE(session.token == kToken);
  REQUIRE(session.startedAt == "2026-08-26T12:00:00Z");
}

TEST_CASE("a mismatched protocol version is refused") {
  SessionDescriptor session;
  REQUIRE(parse(descriptor(kToken, 2, 8734), session) == SessionStatus::UnsupportedVersion);
  REQUIRE(parse(descriptor(kToken, 0, 8734), session) == SessionStatus::UnsupportedVersion);
}

TEST_CASE("out of range ports are refused") {
  SessionDescriptor session;
  REQUIRE(parse(descriptor(kToken, 1, 0), session) == SessionStatus::InvalidPort);
  REQUIRE(parse(descriptor(kToken, 1, 65536), session) == SessionStatus::InvalidPort);
  REQUIRE(parse(descriptor(kToken, 1, 65535), session) == SessionStatus::Ok);
}

TEST_CASE("weak or malformed tokens are refused") {
  SessionDescriptor session;
  REQUIRE(parse(descriptor("short", 1, 8734), session) == SessionStatus::InvalidToken);

  std::string oversized(kMaxTokenChars + 1, 'a');
  REQUIRE(parse(descriptor(oversized.c_str(), 1, 8734), session) == SessionStatus::InvalidToken);

  // A token carrying whitespace or control characters would not survive the
  // handshake intact and suggests a corrupted or hostile descriptor.
  std::string spaced(kMinTokenChars, 'a');
  spaced[4] = ' ';
  REQUIRE(parse(descriptor(spaced.c_str(), 1, 8734), session) == SessionStatus::InvalidToken);
}

TEST_CASE("missing fields are refused") {
  SessionDescriptor session;
  const char* documents[] = {
      "{}",
      "{\"protocolVersion\":1}",
      "{\"protocolVersion\":1,\"instanceId\":\"a\",\"pid\":1,\"port\":80}",
      "{\"instanceId\":\"a\",\"pid\":1,\"port\":80,\"token\":\"0123456789abcdef0123456789abcdef\"}",
  };
  for (const char* document : documents) {
    REQUIRE(parseSessionDescriptor(document, std::strlen(document), session) ==
            SessionStatus::MissingField);
  }
}

TEST_CASE("malformed documents are refused") {
  SessionDescriptor session;
  const char* documents[] = {"", "{", "not json", "[]", "{\"protocolVersion\":1,}"};
  for (const char* document : documents) {
    REQUIRE(parseSessionDescriptor(document, std::strlen(document), session) ==
            SessionStatus::Malformed);
  }
  REQUIRE(parseSessionDescriptor(nullptr, 10, session) == SessionStatus::Malformed);
}

TEST_CASE("an oversized descriptor is refused before parsing") {
  SessionDescriptor session;
  const std::string oversized(kMaxSessionDescriptorBytes + 1, 'a');
  REQUIRE(parse(oversized, session) == SessionStatus::TooLarge);
}

TEST_CASE("a missing file reports not found") {
  SessionDescriptor session;
  REQUIRE(loadSessionDescriptor("", session) == SessionStatus::NotFound);
  REQUIRE(loadSessionDescriptor("S:/netsuflow-does-not-exist/session.json", session) ==
          SessionStatus::NotFound);
}

MICROTEST_MAIN()
