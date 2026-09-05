#include "Protocol.hpp"

#include <cstring>
#include <string>
#include <vector>

#include "MicroTest.hpp"
#include "MiniJson.hpp"

using namespace netsuflow;
using namespace netsuflow::protocol;

namespace {

std::vector<std::uint8_t> encode(const Header& header) {
  std::vector<std::uint8_t> raw(kHeaderSize);
  encodeHeader(header, raw.data());
  return raw;
}

Header validHeader() {
  Header header;
  header.type = static_cast<std::uint16_t>(MessageType::FrameOk);
  header.requestId = 7;
  header.metadataLength = 0;
  header.bodyLength = 0;
  return header;
}

std::string frameMetadataJson(std::uint32_t width, std::uint32_t height, std::uint32_t stride,
                              std::uint32_t frame, const char* format, const char* alpha) {
  json::Writer writer;
  writer.number("width", width)
      .number("height", height)
      .number("stride", stride)
      .number("frame", frame)
      .string("pixelFormat", format)
      .string("alphaMode", alpha);
  return writer.finish();
}

MetadataStatus decode(const std::string& metadata, std::uint32_t bodyLength,
                      FrameMetadata& out) {
  return decodeFrameMetadata(reinterpret_cast<const std::uint8_t*>(metadata.data()),
                             metadata.size(), bodyLength, out);
}

}  // namespace

TEST_CASE("header round trips") {
  Header header = validHeader();
  header.flags = 0xDEADBEEF;
  header.metadataLength = 1234;
  header.bodyLength = 987654;

  const auto raw = encode(header);
  Header decoded;
  REQUIRE(decodeHeader(raw.data(), raw.size(), decoded) == HeaderStatus::Ok);
  REQUIRE(decoded.magic == kMagic);
  REQUIRE(decoded.version == kVersion);
  REQUIRE(decoded.type == header.type);
  REQUIRE(decoded.flags == header.flags);
  REQUIRE(decoded.requestId == header.requestId);
  REQUIRE(decoded.metadataLength == header.metadataLength);
  REQUIRE(decoded.bodyLength == header.bodyLength);
}

TEST_CASE("header uses network byte order") {
  Header header = validHeader();
  header.requestId = 0x01020304;
  const auto raw = encode(header);
  REQUIRE(raw[0] == 'N');
  REQUIRE(raw[1] == 'F');
  REQUIRE(raw[2] == 'X');
  REQUIRE(raw[3] == '1');
  REQUIRE(raw[12] == 0x01);
  REQUIRE(raw[13] == 0x02);
  REQUIRE(raw[14] == 0x03);
  REQUIRE(raw[15] == 0x04);
}

TEST_CASE("truncated header is refused") {
  const auto raw = encode(validHeader());
  Header decoded;
  for (std::size_t size = 0; size < kHeaderSize; ++size) {
    REQUIRE(decodeHeader(raw.data(), size, decoded) == HeaderStatus::Truncated);
  }
  REQUIRE(decodeHeader(nullptr, kHeaderSize, decoded) == HeaderStatus::Truncated);
}

TEST_CASE("bad magic is refused") {
  auto raw = encode(validHeader());
  raw[0] = 'X';
  Header decoded;
  REQUIRE(decodeHeader(raw.data(), raw.size(), decoded) == HeaderStatus::BadMagic);
}

TEST_CASE("unsupported version is refused") {
  Header header = validHeader();
  header.version = kVersion + 1;
  const auto raw = encode(header);
  Header decoded;
  REQUIRE(decodeHeader(raw.data(), raw.size(), decoded) == HeaderStatus::UnsupportedVersion);
}

TEST_CASE("unknown message types are refused") {
  for (const std::uint16_t type : {std::uint16_t{0}, std::uint16_t{12}, std::uint16_t{65535}}) {
    Header header = validHeader();
    header.type = type;
    const auto raw = encode(header);
    Header decoded;
    REQUIRE(decodeHeader(raw.data(), raw.size(), decoded) == HeaderStatus::UnknownType);
  }
}

TEST_CASE("lengths above the configured maximum are refused") {
  Header metadataHeader = validHeader();
  metadataHeader.metadataLength = kMaxMetadataLength + 1;
  auto raw = encode(metadataHeader);
  Header decoded;
  REQUIRE(decodeHeader(raw.data(), raw.size(), decoded) == HeaderStatus::MetadataTooLarge);

  Header bodyHeader = validHeader();
  bodyHeader.bodyLength = kMaxBodyLength + 1;
  raw = encode(bodyHeader);
  REQUIRE(decodeHeader(raw.data(), raw.size(), decoded) == HeaderStatus::BodyTooLarge);

  Header maxBody = validHeader();
  maxBody.bodyLength = 0xFFFFFFFFu;
  raw = encode(maxBody);
  REQUIRE(decodeHeader(raw.data(), raw.size(), decoded) == HeaderStatus::BodyTooLarge);
}

TEST_CASE("valid frame metadata is accepted") {
  const std::uint32_t width = 1920, height = 1080, stride = 1920 * 4;
  const std::string metadata =
      frameMetadataJson(width, height, stride, 24, "RGBA8", "straight");
  FrameMetadata parsed;
  REQUIRE(decode(metadata, stride * height, parsed) == MetadataStatus::Ok);
  REQUIRE(parsed.width == width);
  REQUIRE(parsed.height == height);
  REQUIRE(parsed.stride == stride);
  REQUIRE(parsed.frame == 24);
  REQUIRE(parsed.pixelFormat == "RGBA8");
  REQUIRE(parsed.alphaMode == "straight");
}

TEST_CASE("padded stride is accepted when the body matches") {
  const std::uint32_t width = 100, height = 10, stride = 512;
  const std::string metadata = frameMetadataJson(width, height, stride, 0, "RGBA8", "straight");
  FrameMetadata parsed;
  REQUIRE(decode(metadata, stride * height, parsed) == MetadataStatus::Ok);
}

TEST_CASE("stride below one row is refused") {
  const std::string metadata = frameMetadataJson(100, 10, 399, 0, "RGBA8", "straight");
  FrameMetadata parsed;
  REQUIRE(decode(metadata, 399 * 10, parsed) == MetadataStatus::StrideTooSmall);
}

TEST_CASE("body length must equal stride times height") {
  const std::string metadata = frameMetadataJson(100, 10, 400, 0, "RGBA8", "straight");
  FrameMetadata parsed;
  REQUIRE(decode(metadata, 400 * 10 - 1, parsed) == MetadataStatus::BodyLengthMismatch);
  REQUIRE(decode(metadata, 400 * 10 + 1, parsed) == MetadataStatus::BodyLengthMismatch);
  REQUIRE(decode(metadata, 0, parsed) == MetadataStatus::BodyLengthMismatch);
}

TEST_CASE("dimensions outside the supported range are refused") {
  FrameMetadata parsed;
  REQUIRE(decode(frameMetadataJson(0, 10, 40, 0, "RGBA8", "straight"), 400, parsed) ==
          MetadataStatus::DimensionOutOfRange);
  REQUIRE(decode(frameMetadataJson(10, 0, 40, 0, "RGBA8", "straight"), 400, parsed) ==
          MetadataStatus::DimensionOutOfRange);
  REQUIRE(decode(frameMetadataJson(kMaxDimension + 1, 10, 40, 0, "RGBA8", "straight"), 400,
                 parsed) == MetadataStatus::DimensionOutOfRange);
  REQUIRE(decode(frameMetadataJson(10, kMaxDimension + 1, 40, 0, "RGBA8", "straight"), 400,
                 parsed) == MetadataStatus::DimensionOutOfRange);
}

TEST_CASE("a stride and height product that would wrap in 32 bits is refused") {
  // stride * height overflows uint32 and wraps to a small, plausible value.
  // Evaluated in 64 bits the mismatch is obvious; evaluated in 32 bits it would
  // look like a valid 65536-byte body and hand the caller a tiny buffer to read
  // as a huge image.
  const std::uint32_t stride = 65536 * 4;      // 262144
  const std::uint32_t height = 16384;          // stride * height == 2^32 exactly
  const std::string metadata =
      frameMetadataJson(16384, height, stride, 0, "RGBA8", "straight");
  FrameMetadata parsed;
  REQUIRE(decode(metadata, 0, parsed) == MetadataStatus::BodyLengthMismatch);
  REQUIRE(decode(metadata, kMaxBodyLength, parsed) == MetadataStatus::BodyLengthMismatch);
}

TEST_CASE("unsupported pixel formats and alpha modes are refused") {
  FrameMetadata parsed;
  REQUIRE(decode(frameMetadataJson(4, 4, 16, 0, "BGRA8", "straight"), 64, parsed) ==
          MetadataStatus::UnsupportedPixelFormat);
  REQUIRE(decode(frameMetadataJson(4, 4, 16, 0, "", "straight"), 64, parsed) ==
          MetadataStatus::UnsupportedPixelFormat);
  REQUIRE(decode(frameMetadataJson(4, 4, 16, 0, "RGBA8", "associated"), 64, parsed) ==
          MetadataStatus::UnsupportedAlphaMode);
}

TEST_CASE("RGBA32F requires sixteen bytes per pixel") {
  REQUIRE(bytesPerPixel("RGBA32F") == 16);
  REQUIRE(bytesPerPixel("RGBA8") == 4);
  REQUIRE(bytesPerPixel("nonsense") == 0);
  FrameMetadata parsed;
  REQUIRE(decode(frameMetadataJson(8, 8, 8 * 4, 0, "RGBA32F", "straight"), 8 * 4 * 8, parsed) ==
          MetadataStatus::StrideTooSmall);
  REQUIRE(decode(frameMetadataJson(8, 8, 8 * 16, 0, "RGBA32F", "straight"), 8 * 16 * 8, parsed) ==
          MetadataStatus::Ok);
}

TEST_CASE("missing fields are refused") {
  FrameMetadata parsed;
  json::Writer writer;
  writer.number("width", 4).number("height", 4).number("stride", 16);
  const std::string missing = writer.finish();
  REQUIRE(decode(missing, 64, parsed) == MetadataStatus::MissingField);
}

TEST_CASE("malformed metadata is refused without reading pixels") {
  FrameMetadata parsed;
  const char* documents[] = {
      "",
      "{",
      "}",
      "[]",
      "null",
      "{\"width\":}",
      "{\"width\":4,}",
      "{\"width\":4 \"height\":4}",
      "{\"width\":{\"nested\":1}}",
      "{\"width\":[4]}",
      "{\"width\":\"4\",\"height\":4,\"stride\":16,\"frame\":0,"
      "\"pixelFormat\":\"RGBA8\",\"alphaMode\":\"straight\"}",
      "{\"width\":-4,\"height\":4,\"stride\":16,\"frame\":0,"
      "\"pixelFormat\":\"RGBA8\",\"alphaMode\":\"straight\"}",
      "{\"width\":4.5,\"height\":4,\"stride\":16,\"frame\":0,"
      "\"pixelFormat\":\"RGBA8\",\"alphaMode\":\"straight\"}",
      "{\"width\":99999999999999999999,\"height\":4,\"stride\":16,\"frame\":0,"
      "\"pixelFormat\":\"RGBA8\",\"alphaMode\":\"straight\"}",
  };
  for (const char* document : documents) {
    const MetadataStatus status =
        decodeFrameMetadata(reinterpret_cast<const std::uint8_t*>(document), std::strlen(document),
                            64, parsed);
    REQUIRE(status != MetadataStatus::Ok);
  }
}

TEST_CASE("an unbounded revision string is truncated, not carried through") {
  json::Writer writer;
  const std::string huge(4096, 'r');
  writer.number("width", 4)
      .number("height", 4)
      .number("stride", 16)
      .number("frame", 0)
      .string("pixelFormat", "RGBA8")
      .string("alphaMode", "straight")
      .string("revision", huge);
  const std::string metadata = writer.finish();

  FrameMetadata parsed;
  REQUIRE(decode(metadata, 64, parsed) == MetadataStatus::Ok);
  REQUIRE(parsed.revision.size() == kMaxRevisionChars);
}

TEST_CASE("metadata larger than the document limit is refused") {
  std::string oversized = "{\"width\":4,\"pad\":\"";
  oversized.append(json::kMaxDocumentBytes, 'a');
  oversized += "\"}";
  FrameMetadata parsed;
  REQUIRE(decode(oversized, 64, parsed) == MetadataStatus::Malformed);
}

TEST_CASE("emitted request metadata parses back") {
  const std::string metadata = encodeFrameRequestMetadata(
      "binding-1", "rev-abc", 24, 1920, 1080, 500000, "RGBA8", "straight", "preview", 2000);
  json::Object parsed;
  const char* error = nullptr;
  REQUIRE(json::parseFlatObject(metadata.data(), metadata.size(), parsed, &error));

  std::string binding;
  std::uint32_t frame = 0, width = 0, scale = 0;
  REQUIRE(parsed.getString("binding", binding));
  REQUIRE(binding == "binding-1");
  REQUIRE(parsed.getUint32("frame", frame));
  REQUIRE(frame == 24);
  REQUIRE(parsed.getUint32("width", width));
  REQUIRE(width == 1920);
  REQUIRE(parsed.getUint32("renderScalePpm", scale));
  REQUIRE(scale == 500000);
}

TEST_CASE("emitted metadata escapes hostile binding names") {
  const std::string metadata = encodeFrameRequestMetadata(
      "quote\" brace} newline\n", "rev", 0, 4, 4, 1000000, "RGBA8", "straight", "final", 100);
  json::Object parsed;
  const char* error = nullptr;
  REQUIRE(json::parseFlatObject(metadata.data(), metadata.size(), parsed, &error));
  std::string binding;
  REQUIRE(parsed.getString("binding", binding));
  REQUIRE(binding == "quote\" brace} newline\n");
}

TEST_CASE("fnv1a64 matches the published vectors") {
  // Reference vectors for FNV-1a 64. The empty string is the offset basis
  // itself, which is exactly the constant a typo destroys: a wrong basis still
  // compiles and still hashes, it simply never agrees with the service.
  REQUIRE(fnv1a64Hex("") == "cbf29ce484222325");
  REQUIRE(fnv1a64Hex("a") == "af63dc4c8601ec8c");
  REQUIRE(fnv1a64Hex("foobar") == "85944171f73967e8");
}

TEST_CASE("fnv1a64 is byte-exact, not text-normalising") {
  // A spooled composition is hashed as bytes on one side and read as bytes on
  // the other. Line endings and trailing whitespace must therefore change the
  // hash, or two different files would claim one revision.
  const std::string crlf = std::string("a") + '\r' + '\n' + "b";
  const std::string lf = std::string("a") + '\n' + "b";
  REQUIRE(fnv1a64Hex(crlf) != fnv1a64Hex(lf));
  REQUIRE(fnv1a64Hex("x") != fnv1a64Hex("x "));

  // Bytes above 0x7F must survive as bytes: a composition with accented text
  // hashes the same on both sides only if neither side re-encodes it.
  std::string utf8 = "e";
  utf8 += static_cast<char>(0xC3);
  utf8 += static_cast<char>(0xA9);
  REQUIRE(fnv1a64Hex(utf8).size() == 16);
  REQUIRE(fnv1a64Hex(utf8) != fnv1a64Hex("e"));
}

TEST_CASE("frame request metadata carries composition variables") {
  std::vector<VariableValue> variables;
  variables.push_back({"accent", "\"violet\""});
  variables.push_back({"size", "28"});
  const std::string metadata = encodeFrameRequestMetadata(
      "paste", "0123456789abcdef", 7, 1920, 1080, 1000000, "RGBA8", "straight", "preview", 2000,
      variables);

  json::Object parsed;
  const char* error = nullptr;
  REQUIRE(json::parseFlatObject(metadata.data(), metadata.size(), parsed, &error));

  std::uint32_t count = 0;
  REQUIRE(parsed.getUint32("varCount", count));
  REQUIRE(count == 2);
  std::string packed;
  // The separator is built rather than written inline: a 0x1F typed into
  // source is invisible in every editor and diff, so a wrong one would read
  // as correct.
  const char unitSeparator = '';
  REQUIRE(parsed.getString("var0", packed));
  REQUIRE(packed == std::string("accent") + unitSeparator + "\"violet\"");
  REQUIRE(parsed.getString("var1", packed));
  REQUIRE(packed == std::string("size") + unitSeparator + "28");
}

TEST_CASE("variables beyond the cap are dropped, not overflowed") {
  // The flat document has a hard key cap; silently exceeding it would make the
  // whole request unparseable rather than merely incomplete.
  std::vector<VariableValue> variables;
  for (std::size_t i = 0; i < kMaxVariables + 5; ++i) {
    variables.push_back({"id" + std::to_string(i), "v"});
  }
  const std::string metadata = encodeFrameRequestMetadata(
      "b", "r", 0, 4, 4, 1000000, "RGBA8", "straight", "final", 100, variables);
  json::Object parsed;
  const char* error = nullptr;
  REQUIRE(json::parseFlatObject(metadata.data(), metadata.size(), parsed, &error));
  std::uint32_t count = 0;
  REQUIRE(parsed.getUint32("varCount", count));
  REQUIRE(count == kMaxVariables);
}

TEST_CASE("json parser rejects nesting and accepts escapes") {
  json::Object parsed;
  const char* error = nullptr;
  REQUIRE(!json::parseFlatObject("{\"a\":{\"b\":1}}", 13, parsed, &error));
  REQUIRE(!json::parseFlatObject("{\"a\":[1]}", 9, parsed, &error));

  const std::string unicode = "{\"a\":\"\\u00e9\\ud83d\\ude00\"}";
  REQUIRE(json::parseFlatObject(unicode.data(), unicode.size(), parsed, &error));
  std::string value;
  REQUIRE(parsed.getString("a", value));
  REQUIRE(value == "\xC3\xA9\xF0\x9F\x98\x80");

  const std::string loneSurrogate = "{\"a\":\"\\ud83d\"}";
  REQUIRE(!json::parseFlatObject(loneSurrogate.data(), loneSurrogate.size(), parsed, &error));
}

TEST_CASE("json parser enforces the key limit") {
  std::string document = "{";
  for (std::size_t i = 0; i <= json::kMaxKeys; ++i) {
    if (i > 0) document += ",";
    document += "\"k" + std::to_string(i) + "\":1";
  }
  document += "}";
  json::Object parsed;
  const char* error = nullptr;
  REQUIRE(!json::parseFlatObject(document.data(), document.size(), parsed, &error));
}

MICROTEST_MAIN()
