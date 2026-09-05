#include "Protocol.hpp"

#include <algorithm>

#include "MiniJson.hpp"

namespace netsuflow {
namespace protocol {
namespace {

inline void writeU16(std::uint8_t* out, std::uint16_t value) noexcept {
  out[0] = static_cast<std::uint8_t>((value >> 8) & 0xFFu);
  out[1] = static_cast<std::uint8_t>(value & 0xFFu);
}

inline void writeU32(std::uint8_t* out, std::uint32_t value) noexcept {
  out[0] = static_cast<std::uint8_t>((value >> 24) & 0xFFu);
  out[1] = static_cast<std::uint8_t>((value >> 16) & 0xFFu);
  out[2] = static_cast<std::uint8_t>((value >> 8) & 0xFFu);
  out[3] = static_cast<std::uint8_t>(value & 0xFFu);
}

inline std::uint16_t readU16(const std::uint8_t* in) noexcept {
  return static_cast<std::uint16_t>((static_cast<std::uint16_t>(in[0]) << 8) |
                                    static_cast<std::uint16_t>(in[1]));
}

inline std::uint32_t readU32(const std::uint8_t* in) noexcept {
  return (static_cast<std::uint32_t>(in[0]) << 24) | (static_cast<std::uint32_t>(in[1]) << 16) |
         (static_cast<std::uint32_t>(in[2]) << 8) | static_cast<std::uint32_t>(in[3]);
}

}  // namespace

bool isKnownMessageType(std::uint16_t raw) noexcept {
  return raw >= static_cast<std::uint16_t>(MessageType::Hello) &&
         raw <= static_cast<std::uint16_t>(MessageType::Error);
}

void encodeHeader(const Header& header, std::uint8_t out[kHeaderSize]) noexcept {
  writeU32(out + 0, header.magic);
  writeU16(out + 4, header.version);
  writeU16(out + 6, header.type);
  writeU32(out + 8, header.flags);
  writeU32(out + 12, header.requestId);
  writeU32(out + 16, header.metadataLength);
  writeU32(out + 20, header.bodyLength);
}

HeaderStatus decodeHeader(const std::uint8_t* data, std::size_t size, Header& out) noexcept {
  if (data == nullptr || size < kHeaderSize) return HeaderStatus::Truncated;

  Header parsed;
  parsed.magic = readU32(data + 0);
  parsed.version = readU16(data + 4);
  parsed.type = readU16(data + 6);
  parsed.flags = readU32(data + 8);
  parsed.requestId = readU32(data + 12);
  parsed.metadataLength = readU32(data + 16);
  parsed.bodyLength = readU32(data + 20);

  if (parsed.magic != kMagic) return HeaderStatus::BadMagic;
  if (parsed.version != kVersion) return HeaderStatus::UnsupportedVersion;
  if (!isKnownMessageType(parsed.type)) return HeaderStatus::UnknownType;
  if (parsed.metadataLength > kMaxMetadataLength) return HeaderStatus::MetadataTooLarge;
  if (parsed.bodyLength > kMaxBodyLength) return HeaderStatus::BodyTooLarge;

  out = parsed;
  return HeaderStatus::Ok;
}

const char* describe(HeaderStatus status) noexcept {
  switch (status) {
    case HeaderStatus::Ok: return "ok";
    case HeaderStatus::Truncated: return "truncated header";
    case HeaderStatus::BadMagic: return "bad magic";
    case HeaderStatus::UnsupportedVersion: return "unsupported protocol version";
    case HeaderStatus::UnknownType: return "unknown message type";
    case HeaderStatus::MetadataTooLarge: return "metadata length above maximum";
    case HeaderStatus::BodyTooLarge: return "body length above maximum";
  }
  return "unknown header status";
}

const char* describe(MetadataStatus status) noexcept {
  switch (status) {
    case MetadataStatus::Ok: return "ok";
    case MetadataStatus::Malformed: return "malformed metadata document";
    case MetadataStatus::MissingField: return "missing required metadata field";
    case MetadataStatus::UnsupportedPixelFormat: return "unsupported pixel format";
    case MetadataStatus::UnsupportedAlphaMode: return "unsupported alpha mode";
    case MetadataStatus::DimensionOutOfRange: return "dimension out of range";
    case MetadataStatus::StrideTooSmall: return "stride smaller than one row";
    case MetadataStatus::BodyLengthMismatch: return "body length does not match stride and height";
  }
  return "unknown metadata status";
}

std::uint32_t bytesPerPixel(const std::string& pixelFormat) noexcept {
  if (pixelFormat == "RGBA8") return 4;
  if (pixelFormat == "RGBA32F") return 16;
  return 0;
}

MetadataStatus decodeFrameMetadata(const std::uint8_t* metadata, std::size_t metadataSize,
                                   std::uint32_t bodyLength, FrameMetadata& out) noexcept try {
  // The whole body is inside a function-try-block. This function is noexcept and
  // it copies attacker-sized strings, so a std::bad_alloc escaping here would
  // reach std::terminate() and kill the host outright, before the OpenFX Support
  // wrapper's own catch-all ever runs.
  json::Object document;
  const char* error = nullptr;
  if (!json::parseFlatObject(reinterpret_cast<const char*>(metadata), metadataSize, document,
                             &error)) {
    return MetadataStatus::Malformed;
  }

  FrameMetadata parsed;
  if (!document.getUint32("width", parsed.width) ||
      !document.getUint32("height", parsed.height) ||
      !document.getUint32("stride", parsed.stride) ||
      !document.getUint32("frame", parsed.frame) ||
      !document.getString("pixelFormat", parsed.pixelFormat) ||
      !document.getString("alphaMode", parsed.alphaMode)) {
    return MetadataStatus::MissingField;
  }
  // Revision is advisory, so absence is not an error, but its length is not
  // otherwise constrained by anything: bound it here rather than carrying an
  // arbitrary service-chosen string around.
  document.getString("revision", parsed.revision);
  if (parsed.revision.size() > kMaxRevisionChars) parsed.revision.resize(kMaxRevisionChars);

  const std::uint32_t bpp = bytesPerPixel(parsed.pixelFormat);
  if (bpp == 0) return MetadataStatus::UnsupportedPixelFormat;
  if (parsed.alphaMode != "straight" && parsed.alphaMode != "premultiplied") {
    return MetadataStatus::UnsupportedAlphaMode;
  }
  if (parsed.width == 0 || parsed.height == 0 || parsed.width > kMaxDimension ||
      parsed.height > kMaxDimension) {
    return MetadataStatus::DimensionOutOfRange;
  }

  // 64-bit throughout: width and stride are attacker-chosen, so no intermediate
  // product may be evaluated in 32 bits.
  const std::uint64_t rowBytes = static_cast<std::uint64_t>(parsed.width) * bpp;
  if (static_cast<std::uint64_t>(parsed.stride) < rowBytes) return MetadataStatus::StrideTooSmall;

  const std::uint64_t expected =
      static_cast<std::uint64_t>(parsed.stride) * static_cast<std::uint64_t>(parsed.height);
  if (expected != static_cast<std::uint64_t>(bodyLength)) return MetadataStatus::BodyLengthMismatch;

  out = parsed;
  return MetadataStatus::Ok;
} catch (...) {
  return MetadataStatus::Malformed;
}

std::string encodeHelloMetadata(const std::string& token, const std::string& client,
                                const std::string& instanceId) {
  json::Writer writer;
  writer.number("protocolVersion", kVersion)
      .string("token", token)
      .string("client", client)
      .string("instanceId", instanceId);
  return writer.finish();
}

std::string encodeFrameRequestMetadata(const std::string& binding, const std::string& sourceRevision,
                                       std::uint32_t frame, std::uint32_t width,
                                       std::uint32_t height, std::uint32_t renderScalePpm,
                                       const std::string& pixelFormat, const std::string& alphaMode,
                                       const std::string& quality, std::uint32_t deadlineMs) {
  json::Writer writer;
  writer.string("binding", binding)
      .string("sourceRevision", sourceRevision)
      .number("frame", frame)
      .number("width", width)
      .number("height", height)
      .number("renderScalePpm", renderScalePpm)
      .string("pixelFormat", pixelFormat)
      .string("alphaMode", alphaMode)
      .string("quality", quality)
      .number("deadlineMs", deadlineMs);
  return writer.finish();
}

std::string encodeFrameRequestMetadata(const std::string& binding, const std::string& sourceRevision,
                                       std::uint32_t frame, std::uint32_t width,
                                       std::uint32_t height, std::uint32_t renderScalePpm,
                                       const std::string& pixelFormat, const std::string& alphaMode,
                                       const std::string& quality, std::uint32_t deadlineMs,
                                       const std::vector<VariableValue>& variables) {
  json::Writer writer;
  writer.string("binding", binding)
      .string("sourceRevision", sourceRevision)
      .number("frame", frame)
      .number("width", width)
      .number("height", height)
      .number("renderScalePpm", renderScalePpm)
      .string("pixelFormat", pixelFormat)
      .string("alphaMode", alphaMode)
      .string("quality", quality)
      .number("deadlineMs", deadlineMs);
  const std::size_t count = (std::min)(variables.size(), kMaxVariables);
  writer.number("varCount", static_cast<std::uint64_t>(count));
  for (std::size_t i = 0; i < count; ++i) {
    const std::string key = "var" + std::to_string(i);
    writer.string(key.c_str(), variables[i].id + '\x1F' + variables[i].value);
  }
  return writer.finish();
}

std::string encodeDescribeRequestMetadata(const std::string& binding) {
  json::Writer writer;
  writer.string("binding", binding);
  return writer.finish();
}

std::string fnv1a64Hex(const std::string& text) {
  // Hex on purpose. Spelled in decimal the offset basis is twenty digits, and
  // dropping one produces a number that still compiles, still hashes, and still
  // looks plausible — it simply never agrees with the other implementation.
  // That exact typo shipped once and made every paste fail as `stale-revision`.
  constexpr std::uint64_t kOffsetBasis = 0xcbf29ce484222325ull;
  constexpr std::uint64_t kPrime = 0x100000001b3ull;

  std::uint64_t hash = kOffsetBasis;
  for (const unsigned char byte : text) {
    hash ^= byte;
    hash *= kPrime;
  }

  static const char* const kDigits = "0123456789abcdef";
  std::string out(16, '0');
  for (int i = 15; i >= 0; --i) {
    out[static_cast<std::size_t>(i)] = kDigits[hash & 0xFu];
    hash >>= 4;
  }
  return out;
}

}  // namespace protocol
}  // namespace netsuflow
