// Wire format for the NetsuFlow bridge.
//
// Fixed 24-byte header, network byte order, followed by an optional flat JSON
// metadata document and an optional binary body. Pixels never travel through
// JSON; the metadata only describes them.
//
//   offset size field
//   0      4    magic            'N' 'F' 'X' '1'
//   4      2    protocolVersion
//   6      2    messageType
//   8      4    flags
//   12     4    requestId
//   16     4    metadataLength
//   20     4    bodyLength
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace netsuflow {
namespace protocol {

inline constexpr std::uint32_t kMagic = 0x4E465831u;  // "NFX1"
inline constexpr std::uint16_t kVersion = 1;
inline constexpr std::size_t kHeaderSize = 24;

inline constexpr std::uint32_t kMaxMetadataLength = 64u * 1024u;
/// 256 MiB covers 4K RGBA float32 (about 126 MiB) with headroom and still bounds
/// a single allocation to something a host process can refuse cleanly.
inline constexpr std::uint32_t kMaxBodyLength = 256u * 1024u * 1024u;
inline constexpr std::uint32_t kMaxDimension = 16384;
/// The revision string is advisory and otherwise unconstrained, so it is capped
/// rather than carried around at whatever length the service chose.
inline constexpr std::size_t kMaxRevisionChars = 128;

enum class MessageType : std::uint16_t {
  Hello = 1,
  HelloOk = 2,
  Describe = 3,
  DescribeOk = 4,
  Frame = 5,
  FrameOk = 6,
  Cancel = 7,
  Invalidate = 8,
  Ping = 9,
  Pong = 10,
  Error = 11,
};

bool isKnownMessageType(std::uint16_t raw) noexcept;

struct Header {
  std::uint32_t magic = kMagic;
  std::uint16_t version = kVersion;
  std::uint16_t type = 0;
  std::uint32_t flags = 0;
  std::uint32_t requestId = 0;
  std::uint32_t metadataLength = 0;
  std::uint32_t bodyLength = 0;
};

enum class HeaderStatus {
  Ok,
  Truncated,
  BadMagic,
  UnsupportedVersion,
  UnknownType,
  MetadataTooLarge,
  BodyTooLarge,
};

void encodeHeader(const Header& header, std::uint8_t out[kHeaderSize]) noexcept;
HeaderStatus decodeHeader(const std::uint8_t* data, std::size_t size, Header& out) noexcept;
const char* describe(HeaderStatus status) noexcept;

/// Pixel description carried alongside a FRAME_OK body.
struct FrameMetadata {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t stride = 0;
  std::uint32_t frame = 0;
  std::string pixelFormat;
  std::string alphaMode;
  std::string revision;
};

enum class MetadataStatus {
  Ok,
  Malformed,
  MissingField,
  UnsupportedPixelFormat,
  UnsupportedAlphaMode,
  DimensionOutOfRange,
  StrideTooSmall,
  BodyLengthMismatch,
};

const char* describe(MetadataStatus status) noexcept;

/// Bytes per pixel for a supported format name, or 0 when unsupported.
std::uint32_t bytesPerPixel(const std::string& pixelFormat) noexcept;

/// Validates a FRAME_OK metadata document against the declared body length.
///
/// This is the single gate that decides whether a service-supplied buffer may be
/// read as pixels. Every arithmetic check is performed in 64-bit so a hostile
/// width/height/stride triple cannot wrap into a plausible-looking size.
MetadataStatus decodeFrameMetadata(const std::uint8_t* metadata, std::size_t metadataSize,
                                   std::uint32_t bodyLength, FrameMetadata& out) noexcept;

/// One user-facing composition variable value, flattened for the wire. The
/// metadata document must stay a flat object, so each entry becomes one
/// `varN` key whose value is `id`, a 0x1F unit separator, and the value text.
/// 0x1F cannot appear in either side: identifiers come from HTML attributes
/// and values from Inspector controls, both of which strip control bytes.
struct VariableValue {
  std::string id;
  std::string value;
};

/// Bounded by the Inspector's control pool, not by the protocol: the flat
/// document allows up to json::kMaxKeys keys in total.
inline constexpr std::size_t kMaxVariables = 32;

/// Metadata documents emitted by the plugin.
std::string encodeHelloMetadata(const std::string& token, const std::string& client,
                                const std::string& instanceId);
/// `renderScalePpm` is the render scale in parts per million, so the wire format
/// carries no floating-point text and both implementations agree exactly.
std::string encodeFrameRequestMetadata(const std::string& binding, const std::string& sourceRevision,
                                       std::uint32_t frame, std::uint32_t width,
                                       std::uint32_t height, std::uint32_t renderScalePpm,
                                       const std::string& pixelFormat, const std::string& alphaMode,
                                       const std::string& quality, std::uint32_t deadlineMs);
/// Same document with `varCount`/`varN` entries appended. Entries beyond
/// kMaxVariables are dropped rather than overflowing the flat-object key cap.
std::string encodeFrameRequestMetadata(const std::string& binding, const std::string& sourceRevision,
                                       std::uint32_t frame, std::uint32_t width,
                                       std::uint32_t height, std::uint32_t renderScalePpm,
                                       const std::string& pixelFormat, const std::string& alphaMode,
                                       const std::string& quality, std::uint32_t deadlineMs,
                                       const std::vector<VariableValue>& variables);
/// DESCRIBE request: asks the service what a binding's composition declares.
std::string encodeDescribeRequestMetadata(const std::string& binding);

/// FNV-1a 64 as lowercase hex. This is wire contract, not a local utility: a
/// pasted composition's revision IS this hash of its bytes, and the service
/// computes the same value in JavaScript. The two must agree exactly or every
/// paste is refused as `stale-revision`, so it lives here beside the rest of
/// the format and is pinned by test against published vectors.
std::string fnv1a64Hex(const std::string& text);

}  // namespace protocol
}  // namespace netsuflow
