#include "BridgeClient.hpp"

#include "MiniJson.hpp"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <mutex>
#include <new>
#include <thread>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
using SocketHandle = SOCKET;
static constexpr SocketHandle kInvalidSocket = INVALID_SOCKET;
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
using SocketHandle = int;
static constexpr SocketHandle kInvalidSocket = -1;
#endif

namespace netsuflow {
namespace {

/// Slice used between abort checks while blocked on the socket.
constexpr int kAbortPollMs = 15;

/// Turns an ERROR message's metadata into the string the Inspector shows.
/// The service names its refusal reason there, and a session spent debugging a
/// manual Fusion run proved that "returned an error" alone is six different
/// problems wearing one label. Metadata is untrusted: it goes through the flat
/// parser, and its strings are already length-capped by that parser.
std::string describeServiceError(const std::string& metadata) {
  netsuflow::json::Object parsed;
  if (!netsuflow::json::parseFlatObject(metadata.data(), metadata.size(), parsed, nullptr)) {
    return "renderer service returned an error";
  }
  std::string code;
  std::string detail;
  parsed.getString("code", code);
  parsed.getString("detail", detail);
  if (code.empty() && detail.empty()) return "renderer service returned an error";
  if (detail.empty()) return "service: " + code;
  if (code.empty()) return "service: " + detail;
  return "service: " + code + ": " + detail;
}

std::uint64_t nowMs() noexcept {
  using clock = std::chrono::steady_clock;
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(clock::now().time_since_epoch())
          .count());
}

void initialiseSockets() {
#if defined(_WIN32)
  // Started once per process. WSACleanup is deliberately not called: the plugin
  // is a DLL inside a host that may still be using Winsock, and teardown order
  // during unload is not ours to control.
  static std::once_flag once;
  std::call_once(once, [] {
    WSADATA data;
    WSAStartup(MAKEWORD(2, 2), &data);
  });
#endif
}

void closeSocket(SocketHandle handle) noexcept {
  if (handle == kInvalidSocket) return;
#if defined(_WIN32)
  ::closesocket(handle);
#else
  ::close(handle);
#endif
}

bool setNonBlocking(SocketHandle handle) noexcept {
#if defined(_WIN32)
  u_long mode = 1;
  return ::ioctlsocket(handle, FIONBIO, &mode) == 0;
#else
  const int flags = ::fcntl(handle, F_GETFL, 0);
  if (flags < 0) return false;
  return ::fcntl(handle, F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

bool wouldBlock() noexcept {
#if defined(_WIN32)
  const int error = WSAGetLastError();
  return error == WSAEWOULDBLOCK || error == WSAEINPROGRESS;
#else
  return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
#endif
}

bool connectInProgress() noexcept {
#if defined(_WIN32)
  const int error = WSAGetLastError();
  return error == WSAEWOULDBLOCK || error == WSAEINPROGRESS || error == WSAEALREADY;
#else
  return errno == EINPROGRESS || errno == EINTR;
#endif
}

enum class WaitResult { Ready, TimedOut, Failed };

/// `watchExcept` matters on Winsock: a *failed* asynchronous connect is signalled
/// by marking the socket exceptional, never writable. Without it a refused
/// connection is indistinguishable from a slow one and burns the whole timeout.
WaitResult waitForSocket(SocketHandle handle, bool forWrite, int timeoutMs,
                         bool watchExcept = false) noexcept {
  fd_set set;
  fd_set exceptSet;
  FD_ZERO(&set);
  FD_ZERO(&exceptSet);
#if defined(_WIN32)
#pragma warning(push)
#pragma warning(disable : 4127)
#endif
  FD_SET(handle, &set);
  if (watchExcept) FD_SET(handle, &exceptSet);
#if defined(_WIN32)
#pragma warning(pop)
#endif
  timeval tv;
  tv.tv_sec = timeoutMs / 1000;
  tv.tv_usec = (timeoutMs % 1000) * 1000;

  const int nfds =
#if defined(_WIN32)
      0;
#else
      static_cast<int>(handle) + 1;
#endif
  fd_set* const exceptPtr = watchExcept ? &exceptSet : nullptr;
  const int ready = forWrite ? ::select(nfds, nullptr, &set, exceptPtr, &tv)
                             : ::select(nfds, &set, nullptr, exceptPtr, &tv);
  if (ready > 0) {
    if (watchExcept && FD_ISSET(handle, &exceptSet)) return WaitResult::Failed;
    return WaitResult::Ready;
  }
  if (ready == 0) return WaitResult::TimedOut;
  return WaitResult::Failed;
}

}  // namespace

struct BridgeClient::Impl {
  SocketHandle handle = kInvalidSocket;
};

const char* describe(BridgeStatus status) noexcept {
  switch (status) {
    case BridgeStatus::Ok: return "ok";
    case BridgeStatus::NotConfigured: return "renderer session not configured";
    case BridgeStatus::ConnectFailed: return "could not connect to the renderer service";
    case BridgeStatus::HandshakeFailed: return "renderer service rejected the handshake";
    case BridgeStatus::Timeout: return "renderer service exceeded the deadline";
    case BridgeStatus::Aborted: return "render aborted by the host";
    case BridgeStatus::ProtocolError: return "renderer service sent an invalid message";
    case BridgeStatus::ServiceError: return "renderer service returned an error";
    case BridgeStatus::Disconnected: return "renderer service closed the connection";
  }
  return "unknown bridge status";
}

BridgeClient::BridgeClient() : impl_(new Impl()) {}

BridgeClient::~BridgeClient() {
  close();
  delete impl_;
  impl_ = nullptr;
}

bool BridgeClient::isConnected() const noexcept {
  return connected_ && impl_ != nullptr && impl_->handle != kInvalidSocket;
}

void BridgeClient::close() noexcept {
  if (impl_ != nullptr) {
    closeSocket(impl_->handle);
    impl_->handle = kInvalidSocket;
  }
  connected_ = false;
}

BridgeStatus BridgeClient::fail(BridgeStatus status, const char* reason) {
  lastError_ = reason != nullptr ? reason : describe(status);
  close();
  return status;
}

void BridgeClient::resetConnectBackoff() noexcept {
  connectBackoffMs_ = 0;
  nextConnectAttemptTick_ = 0;
}

BridgeStatus BridgeClient::connect(const std::string& descriptorPath, std::uint32_t timeoutMs) {
  if (isConnected()) return BridgeStatus::Ok;

  if (nowMs() < nextConnectAttemptTick_) {
    // Still inside the backoff window: report the previous failure without
    // touching the network, so the caller returns promptly.
    return lastStatus_ == BridgeStatus::NotConfigured ? BridgeStatus::NotConfigured
                                                      : BridgeStatus::ConnectFailed;
  }

  const BridgeStatus status = connectImpl(descriptorPath, timeoutMs);
  lastStatus_ = status;
  if (status == BridgeStatus::Ok) {
    resetConnectBackoff();
  } else {
    connectBackoffMs_ = connectBackoffMs_ == 0
                            ? kMinConnectBackoffMs
                            : (std::min)(connectBackoffMs_ * 2u, kMaxConnectBackoffMs);
    nextConnectAttemptTick_ = nowMs() + connectBackoffMs_;
  }
  return status;
}

BridgeStatus BridgeClient::connectImpl(const std::string& descriptorPath,
                                       std::uint32_t timeoutMs) {
  close();

  SessionDescriptor descriptor;
  const SessionStatus sessionStatus = loadSessionDescriptor(descriptorPath, descriptor);
  if (sessionStatus != SessionStatus::Ok) {
    lastError_ = describe(sessionStatus);
    return BridgeStatus::NotConfigured;
  }
  session_ = descriptor;

  initialiseSockets();

  const SocketHandle handle = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (handle == kInvalidSocket) return fail(BridgeStatus::ConnectFailed, "socket creation failed");
  impl_->handle = handle;

  if (!setNonBlocking(handle)) {
    return fail(BridgeStatus::ConnectFailed, "could not switch the socket to non-blocking");
  }

  int one = 1;
  ::setsockopt(handle, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof(one));

  // Loopback only. The address is never taken from the descriptor, so a tampered
  // descriptor cannot redirect the plugin to a remote host.
  sockaddr_in address;
  std::memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(session_.port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  const int result =
      ::connect(handle, reinterpret_cast<const sockaddr*>(&address), sizeof(address));
  if (result != 0) {
    if (!connectInProgress()) return fail(BridgeStatus::ConnectFailed, "connect failed");
    const std::uint64_t deadline = nowMs() + timeoutMs;
    bool ready = false;
    while (nowMs() < deadline) {
      const int slice = static_cast<int>(
          (std::min)(static_cast<std::uint64_t>(kAbortPollMs), deadline - nowMs()));
      const WaitResult wait = waitForSocket(handle, true, slice > 0 ? slice : 1, true);
      if (wait == WaitResult::Ready) {
        ready = true;
        break;
      }
      if (wait == WaitResult::Failed) return fail(BridgeStatus::ConnectFailed, "connect refused");
    }
    if (!ready) return fail(BridgeStatus::ConnectFailed, "connect timed out");

    int soError = 0;
#if defined(_WIN32)
    int length = sizeof(soError);
#else
    socklen_t length = sizeof(soError);
#endif
    if (::getsockopt(handle, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&soError), &length) !=
            0 ||
        soError != 0) {
      return fail(BridgeStatus::ConnectFailed, "connect refused");
    }
  }

  connected_ = true;
  const BridgeStatus handshakeStatus = handshake(timeoutMs);
  if (handshakeStatus != BridgeStatus::Ok) return handshakeStatus;

  lastError_.clear();
  return BridgeStatus::Ok;
}

BridgeStatus BridgeClient::handshake(std::uint32_t timeoutMs) {
  instanceId_ = session_.instanceId;
  const std::string metadata =
      protocol::encodeHelloMetadata(session_.token, "netsuflow-ofx", instanceId_);

  const BridgeStatus sent =
      sendMessage(protocol::MessageType::Hello, 0, metadata, timeoutMs, nullptr);
  if (sent != BridgeStatus::Ok) return sent;

  protocol::Header header;
  std::string responseMetadata;
  std::vector<std::uint8_t> body;
  const std::uint64_t deadline = nowMs() + timeoutMs;
  const BridgeStatus received = readMessage(header, responseMetadata, body, deadline, nullptr);
  if (received != BridgeStatus::Ok) return received;

  if (header.type != static_cast<std::uint16_t>(protocol::MessageType::HelloOk)) {
    return fail(BridgeStatus::HandshakeFailed, "handshake rejected");
  }
  if (header.bodyLength != 0) {
    return fail(BridgeStatus::ProtocolError, "handshake carried an unexpected body");
  }
  return BridgeStatus::Ok;
}

BridgeStatus BridgeClient::sendMessage(protocol::MessageType type, std::uint32_t requestId,
                                       const std::string& metadata, std::uint32_t deadlineMs,
                                       const AbortSignal* abort) {
  if (!isConnected()) return BridgeStatus::Disconnected;
  if (metadata.size() > protocol::kMaxMetadataLength) {
    return fail(BridgeStatus::ProtocolError, "outgoing metadata above maximum");
  }

  protocol::Header header;
  header.type = static_cast<std::uint16_t>(type);
  header.requestId = requestId;
  header.metadataLength = static_cast<std::uint32_t>(metadata.size());
  header.bodyLength = 0;

  std::vector<std::uint8_t> buffer(protocol::kHeaderSize + metadata.size());
  protocol::encodeHeader(header, buffer.data());
  if (!metadata.empty()) {
    std::memcpy(buffer.data() + protocol::kHeaderSize, metadata.data(), metadata.size());
  }

  const std::uint64_t deadline = nowMs() + deadlineMs;
  std::size_t offset = 0;
  while (offset < buffer.size()) {
    if (abort != nullptr && abort->aborted()) {
      // Same reasoning as an abandoned response: once part of a message is on
      // the wire, the stream's framing is no longer known, so the connection is
      // dropped instead of reused. Reconnecting is cheap; a desynchronised
      // stream would let the service answer requests that were never finished.
      return fail(BridgeStatus::Aborted, "render aborted by the host");
    }
    if (nowMs() >= deadline) return fail(BridgeStatus::Timeout, "send timed out");

    const int written =
        ::send(impl_->handle, reinterpret_cast<const char*>(buffer.data() + offset),
               static_cast<int>(buffer.size() - offset), 0);
    if (written > 0) {
      offset += static_cast<std::size_t>(written);
      continue;
    }
    if (written == 0) return fail(BridgeStatus::Disconnected, "service closed while sending");
    if (!wouldBlock()) return fail(BridgeStatus::Disconnected, "send failed");

    const WaitResult wait = waitForSocket(impl_->handle, true, kAbortPollMs);
    if (wait == WaitResult::Failed) return fail(BridgeStatus::Disconnected, "send failed");
  }
  return BridgeStatus::Ok;
}

BridgeStatus BridgeClient::readExact(std::uint8_t* out, std::size_t size,
                                     std::uint64_t deadlineTick, const AbortSignal* abort) {
  std::size_t offset = 0;
  // select() reporting readable does not guarantee recv() returns data, so the
  // loop can cycle without progress. It always terminates on the deadline, but
  // without a yield it would spin a core the host owns for up to 30 seconds.
  int spinsWithoutProgress = 0;
  while (offset < size) {
    if (abort != nullptr && abort->aborted()) return BridgeStatus::Aborted;
    if (nowMs() >= deadlineTick) return fail(BridgeStatus::Timeout, "receive timed out");

    const int read = ::recv(impl_->handle, reinterpret_cast<char*>(out + offset),
                            static_cast<int>(size - offset), 0);
    if (read > 0) {
      offset += static_cast<std::size_t>(read);
      spinsWithoutProgress = 0;
      continue;
    }
    if (read == 0) return fail(BridgeStatus::Disconnected, "service closed the connection");
    if (!wouldBlock()) return fail(BridgeStatus::Disconnected, "receive failed");

    const WaitResult wait = waitForSocket(impl_->handle, false, kAbortPollMs);
    if (wait == WaitResult::Failed) return fail(BridgeStatus::Disconnected, "receive failed");
    if (++spinsWithoutProgress > 4) {
      spinsWithoutProgress = 0;
      std::this_thread::yield();
    }
  }
  return BridgeStatus::Ok;
}

BridgeStatus BridgeClient::readMessage(protocol::Header& header, std::string& metadata,
                                       std::vector<std::uint8_t>& body, std::uint64_t deadlineTick,
                                       const AbortSignal* abort) {
  std::uint8_t raw[protocol::kHeaderSize];
  const BridgeStatus headerRead = readExact(raw, sizeof(raw), deadlineTick, abort);
  if (headerRead != BridgeStatus::Ok) return headerRead;

  const protocol::HeaderStatus status = protocol::decodeHeader(raw, sizeof(raw), header);
  if (status != protocol::HeaderStatus::Ok) {
    return fail(BridgeStatus::ProtocolError, protocol::describe(status));
  }

  metadata.clear();
  if (header.metadataLength > 0) {
    // Bounded by kMaxMetadataLength inside decodeHeader before this allocation.
    metadata.resize(header.metadataLength);
    const BridgeStatus metadataRead =
        readExact(reinterpret_cast<std::uint8_t*>(&metadata[0]), metadata.size(), deadlineTick,
                  abort);
    if (metadataRead != BridgeStatus::Ok) return metadataRead;
  }

  body.clear();
  if (header.bodyLength > 0) {
    // Bounded by kMaxBodyLength inside decodeHeader before this allocation.
    try {
      body.resize(header.bodyLength);
    } catch (const std::bad_alloc&) {
      return fail(BridgeStatus::ProtocolError, "declared body does not fit in memory");
    }
    const BridgeStatus bodyRead = readExact(body.data(), body.size(), deadlineTick, abort);
    if (bodyRead != BridgeStatus::Ok) return bodyRead;
  }

  return BridgeStatus::Ok;
}

BridgeStatus BridgeClient::requestFrame(const FrameRequest& request, FrameResponse& response,
                                        const AbortSignal* abort) {
  if (!isConnected()) return BridgeStatus::Disconnected;
  if (request.width == 0 || request.height == 0 || request.width > protocol::kMaxDimension ||
      request.height > protocol::kMaxDimension) {
    lastError_ = "requested dimensions out of range";
    return BridgeStatus::ProtocolError;
  }

  const std::uint32_t requestId = nextRequestId_++;
  if (nextRequestId_ == 0) nextRequestId_ = 1;

  const std::string metadata = protocol::encodeFrameRequestMetadata(
      request.binding, request.sourceRevision, request.frame, request.width, request.height,
      request.renderScalePpm, request.pixelFormat, request.alphaMode, request.quality,
      request.deadlineMs, request.variables);

  const BridgeStatus sent = sendMessage(protocol::MessageType::Frame, requestId, metadata,
                                        request.deadlineMs, abort);
  if (sent != BridgeStatus::Ok) return sent;

  const std::uint64_t deadline = nowMs() + request.deadlineMs;
  protocol::Header header;
  std::string responseMetadata;
  std::vector<std::uint8_t> body;
  const BridgeStatus received = readMessage(header, responseMetadata, body, deadline, abort);
  if (received == BridgeStatus::Aborted) {
    // The stream position is unknown once a response is abandoned mid-flight, so
    // the connection is dropped rather than reused. Reconnecting is cheap and
    // cannot desynchronise a later frame.
    lastError_ = "render aborted by the host";
    close();
    return BridgeStatus::Aborted;
  }
  if (received != BridgeStatus::Ok) return received;

  if (header.requestId != requestId) {
    return fail(BridgeStatus::ProtocolError, "response request id mismatch");
  }
  if (header.type == static_cast<std::uint16_t>(protocol::MessageType::Error)) {
    lastError_ = describeServiceError(responseMetadata);
    return BridgeStatus::ServiceError;
  }
  if (header.type != static_cast<std::uint16_t>(protocol::MessageType::FrameOk)) {
    return fail(BridgeStatus::ProtocolError, "unexpected response message type");
  }

  protocol::FrameMetadata frameMetadata;
  const protocol::MetadataStatus metadataStatus = protocol::decodeFrameMetadata(
      reinterpret_cast<const std::uint8_t*>(responseMetadata.data()), responseMetadata.size(),
      header.bodyLength, frameMetadata);
  if (metadataStatus != protocol::MetadataStatus::Ok) {
    return fail(BridgeStatus::ProtocolError, protocol::describe(metadataStatus));
  }
  if (frameMetadata.width != request.width || frameMetadata.height != request.height) {
    return fail(BridgeStatus::ProtocolError, "response dimensions do not match the request");
  }
  if (frameMetadata.pixelFormat != request.pixelFormat) {
    return fail(BridgeStatus::ProtocolError, "response pixel format does not match the request");
  }
  if (frameMetadata.frame != request.frame) {
    return fail(BridgeStatus::ProtocolError, "response frame does not match the request");
  }

  response.metadata = frameMetadata;
  response.pixels.swap(body);
  lastError_.clear();
  return BridgeStatus::Ok;
}

BridgeStatus BridgeClient::describeComposition(const std::string& binding, std::uint32_t deadlineMs,
                                               std::vector<DescribedVariable>& out,
                                               std::uint32_t* outWidth, std::uint32_t* outHeight,
                                               std::uint32_t* outCodeWidth,
                                               std::uint32_t* outCodeHeight) {
  out.clear();
  if (outWidth != nullptr) *outWidth = 0;
  if (outHeight != nullptr) *outHeight = 0;
  if (outCodeWidth != nullptr) *outCodeWidth = 0;
  if (outCodeHeight != nullptr) *outCodeHeight = 0;
  if (!isConnected()) return BridgeStatus::Disconnected;

  const std::uint32_t requestId = nextRequestId_++;
  if (nextRequestId_ == 0) nextRequestId_ = 1;

  const std::string metadata = protocol::encodeDescribeRequestMetadata(binding);
  const BridgeStatus sent =
      sendMessage(protocol::MessageType::Describe, requestId, metadata, deadlineMs, nullptr);
  if (sent != BridgeStatus::Ok) return sent;

  const std::uint64_t deadline = nowMs() + deadlineMs;
  protocol::Header header;
  std::string responseMetadata;
  std::vector<std::uint8_t> body;
  const BridgeStatus received = readMessage(header, responseMetadata, body, deadline, nullptr);
  if (received != BridgeStatus::Ok) return received;

  if (header.requestId != requestId) {
    return fail(BridgeStatus::ProtocolError, "response request id mismatch");
  }
  if (header.type == static_cast<std::uint16_t>(protocol::MessageType::Error)) {
    lastError_ = describeServiceError(responseMetadata);
    return BridgeStatus::ServiceError;
  }
  if (header.type != static_cast<std::uint16_t>(protocol::MessageType::DescribeOk)) {
    return fail(BridgeStatus::ProtocolError, "unexpected response message type");
  }

  json::Object parsed;
  const char* error = nullptr;
  if (!json::parseFlatObject(responseMetadata.data(), responseMetadata.size(), parsed, &error)) {
    return fail(BridgeStatus::ProtocolError, error != nullptr ? error : "malformed describe reply");
  }

  if (outWidth != nullptr) parsed.getUint32("width", *outWidth);
  if (outHeight != nullptr) parsed.getUint32("height", *outHeight);
  // Absent when the composition declares no size of its own, which is why the
  // fields are only overwritten when the key is actually present.
  if (outCodeWidth != nullptr) parsed.getUint32("codeWidth", *outCodeWidth);
  if (outCodeHeight != nullptr) parsed.getUint32("codeHeight", *outCodeHeight);

  std::uint32_t count = 0;
  parsed.getUint32("varCount", count);
  count = (std::min)(count, static_cast<std::uint32_t>(protocol::kMaxVariables));

  for (std::uint32_t i = 0; i < count; ++i) {
    const std::string key = "var" + std::to_string(i);
    std::string packed;
    if (!parsed.getString(key.c_str(), packed)) continue;

    // id \x1F type \x1F label \x1F default \x1F min \x1F max \x1F step \x1F options
    // \x1F optionLabels \x1F unit — the last two are newer than the first
    // eight; a service that does not send them leaves them empty here.
    DescribedVariable variable;
    std::string* const fields[] = {&variable.id,  &variable.type, &variable.label,
                                   &variable.defaultValue, &variable.min,  &variable.max,
                                   &variable.step, &variable.options,
                                   &variable.optionLabels, &variable.unit};
    std::size_t field = 0;
    std::size_t start = 0;
    for (std::size_t at = 0; at <= packed.size() && field < 10; ++at) {
      if (at == packed.size() || packed[at] == '\x1F') {
        *fields[field] = packed.substr(start, at - start);
        field += 1;
        start = at + 1;
      }
    }
    if (!variable.id.empty()) out.push_back(std::move(variable));
  }

  lastError_.clear();
  return BridgeStatus::Ok;
}

}  // namespace netsuflow
