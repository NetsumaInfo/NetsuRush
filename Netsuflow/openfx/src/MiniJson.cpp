#include "MiniJson.hpp"

#include <cstring>

namespace netsuflow {
namespace json {
namespace {

struct Cursor {
  const char* data;
  std::size_t size;
  std::size_t pos;

  bool done() const noexcept { return pos >= size; }
  char peek() const noexcept { return pos < size ? data[pos] : '\0'; }
  bool consume(char c) noexcept {
    if (pos < size && data[pos] == c) {
      ++pos;
      return true;
    }
    return false;
  }
};

void skipWhitespace(Cursor& c) noexcept {
  while (c.pos < c.size) {
    const char ch = c.data[c.pos];
    if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
      ++c.pos;
    } else {
      break;
    }
  }
}

void appendUtf8(std::uint32_t codepoint, std::string& out) {
  if (codepoint <= 0x7F) {
    out.push_back(static_cast<char>(codepoint));
  } else if (codepoint <= 0x7FF) {
    out.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
    out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
  } else if (codepoint <= 0xFFFF) {
    out.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
    out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (codepoint >> 18)));
    out.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
  }
}

bool parseHex4(Cursor& c, std::uint32_t& out) noexcept {
  if (c.pos + 4 > c.size) return false;
  std::uint32_t value = 0;
  for (int i = 0; i < 4; ++i) {
    const char ch = c.data[c.pos + static_cast<std::size_t>(i)];
    std::uint32_t digit;
    if (ch >= '0' && ch <= '9') {
      digit = static_cast<std::uint32_t>(ch - '0');
    } else if (ch >= 'a' && ch <= 'f') {
      digit = static_cast<std::uint32_t>(ch - 'a' + 10);
    } else if (ch >= 'A' && ch <= 'F') {
      digit = static_cast<std::uint32_t>(ch - 'A' + 10);
    } else {
      return false;
    }
    value = (value << 4) | digit;
  }
  c.pos += 4;
  out = value;
  return true;
}

bool parseString(Cursor& c, std::string& out) {
  if (!c.consume('"')) return false;
  out.clear();
  while (true) {
    if (c.done()) return false;
    if (out.size() > kMaxStringBytes) return false;
    const char ch = c.data[c.pos++];
    if (ch == '"') return true;
    if (static_cast<unsigned char>(ch) < 0x20) return false;  // raw control char
    if (ch != '\\') {
      out.push_back(ch);
      continue;
    }
    if (c.done()) return false;
    const char esc = c.data[c.pos++];
    switch (esc) {
      case '"': out.push_back('"'); break;
      case '\\': out.push_back('\\'); break;
      case '/': out.push_back('/'); break;
      case 'b': out.push_back('\b'); break;
      case 'f': out.push_back('\f'); break;
      case 'n': out.push_back('\n'); break;
      case 'r': out.push_back('\r'); break;
      case 't': out.push_back('\t'); break;
      case 'u': {
        std::uint32_t unit = 0;
        if (!parseHex4(c, unit)) return false;
        if (unit >= 0xD800 && unit <= 0xDBFF) {
          // High surrogate: a matching low surrogate is mandatory.
          if (!c.consume('\\') || !c.consume('u')) return false;
          std::uint32_t low = 0;
          if (!parseHex4(c, low)) return false;
          if (low < 0xDC00 || low > 0xDFFF) return false;
          unit = 0x10000u + ((unit - 0xD800u) << 10) + (low - 0xDC00u);
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
          return false;  // lone low surrogate
        }
        appendUtf8(unit, out);
        break;
      }
      default:
        return false;
    }
  }
}

bool parseNumberToken(Cursor& c, std::string& out) {
  const std::size_t start = c.pos;
  if (c.pos < c.size && c.data[c.pos] == '-') ++c.pos;
  const std::size_t intStart = c.pos;
  while (c.pos < c.size && c.data[c.pos] >= '0' && c.data[c.pos] <= '9') ++c.pos;
  if (c.pos == intStart) return false;
  // Leading zeros are not valid JSON beyond a bare "0".
  if (c.data[intStart] == '0' && c.pos - intStart > 1) return false;
  if (c.pos < c.size && c.data[c.pos] == '.') {
    ++c.pos;
    const std::size_t fracStart = c.pos;
    while (c.pos < c.size && c.data[c.pos] >= '0' && c.data[c.pos] <= '9') ++c.pos;
    if (c.pos == fracStart) return false;
  }
  if (c.pos < c.size && (c.data[c.pos] == 'e' || c.data[c.pos] == 'E')) {
    ++c.pos;
    if (c.pos < c.size && (c.data[c.pos] == '+' || c.data[c.pos] == '-')) ++c.pos;
    const std::size_t expStart = c.pos;
    while (c.pos < c.size && c.data[c.pos] >= '0' && c.data[c.pos] <= '9') ++c.pos;
    if (c.pos == expStart) return false;
  }
  const std::size_t length = c.pos - start;
  if (length == 0 || length > kMaxNumberChars) return false;
  out.assign(c.data + start, length);
  return true;
}

bool parseLiteral(Cursor& c, const char* literal, std::size_t length) noexcept {
  if (c.pos + length > c.size) return false;
  if (std::memcmp(c.data + c.pos, literal, length) != 0) return false;
  c.pos += length;
  return true;
}

bool parseScalar(Cursor& c, Value& out) {
  skipWhitespace(c);
  if (c.done()) return false;
  const char ch = c.peek();
  if (ch == '"') {
    out.type = ValueType::String;
    return parseString(c, out.text);
  }
  if (ch == 't') {
    if (!parseLiteral(c, "true", 4)) return false;
    out.type = ValueType::Bool;
    out.boolean = true;
    return true;
  }
  if (ch == 'f') {
    if (!parseLiteral(c, "false", 5)) return false;
    out.type = ValueType::Bool;
    out.boolean = false;
    return true;
  }
  if (ch == 'n') {
    if (!parseLiteral(c, "null", 4)) return false;
    out.type = ValueType::Null;
    return true;
  }
  if (ch == '-' || (ch >= '0' && ch <= '9')) {
    out.type = ValueType::Number;
    return parseNumberToken(c, out.text);
  }
  return false;  // '{' and '[' land here: nesting is refused by design
}

bool decimalToUint64(const std::string& token, std::uint64_t& out) noexcept {
  if (token.empty() || token.size() > 20) return false;
  std::uint64_t value = 0;
  for (const char ch : token) {
    if (ch < '0' || ch > '9') return false;  // rejects '-', '.', 'e'
    const std::uint64_t digit = static_cast<std::uint64_t>(ch - '0');
    if (value > (UINT64_MAX - digit) / 10u) return false;
    value = value * 10u + digit;
  }
  out = value;
  return true;
}

}  // namespace

void Object::insert(std::string key, Value value) {
  entries_.emplace_back(std::move(key), std::move(value));
}

const Value* Object::find(const char* key) const noexcept {
  for (const auto& entry : entries_) {
    if (entry.first == key) return &entry.second;
  }
  return nullptr;
}

bool Object::has(const char* key) const noexcept { return find(key) != nullptr; }

bool Object::getString(const char* key, std::string& out) const {
  const Value* value = find(key);
  if (value == nullptr || value->type != ValueType::String) return false;
  out = value->text;
  return true;
}

bool Object::getUint64(const char* key, std::uint64_t& out) const {
  const Value* value = find(key);
  if (value == nullptr || value->type != ValueType::Number) return false;
  return decimalToUint64(value->text, out);
}

bool Object::getUint32(const char* key, std::uint32_t& out) const {
  std::uint64_t wide = 0;
  if (!getUint64(key, wide)) return false;
  if (wide > 0xFFFFFFFFull) return false;
  out = static_cast<std::uint32_t>(wide);
  return true;
}

bool Object::getBool(const char* key, bool& out) const {
  const Value* value = find(key);
  if (value == nullptr || value->type != ValueType::Bool) return false;
  out = value->boolean;
  return true;
}

bool parseFlatObject(const char* data, std::size_t size, Object& out,
                     const char** error) noexcept {
  const auto reject = [&](const char* reason) {
    if (error != nullptr) *error = reason;
    out.clear();
    return false;
  };
  if (error != nullptr) *error = "";
  out.clear();

  if (data == nullptr) return reject("null document");
  if (size > kMaxDocumentBytes) return reject("document too large");

  Cursor c{data, size, 0};
  try {
    skipWhitespace(c);
    if (!c.consume('{')) return reject("expected object");
    skipWhitespace(c);
    if (c.consume('}')) {
      skipWhitespace(c);
      return c.done() ? true : reject("trailing bytes");
    }
    while (true) {
      if (out.size() >= kMaxKeys) return reject("too many keys");
      skipWhitespace(c);
      std::string key;
      if (!parseString(c, key)) return reject("expected key");
      skipWhitespace(c);
      if (!c.consume(':')) return reject("expected colon");
      Value value;
      if (!parseScalar(c, value)) return reject("expected scalar value");
      out.insert(std::move(key), std::move(value));
      skipWhitespace(c);
      if (c.consume(',')) continue;
      if (c.consume('}')) break;
      return reject("expected comma or end of object");
    }
    skipWhitespace(c);
    if (!c.done()) return reject("trailing bytes");
    return true;
  } catch (...) {
    return reject("allocation failure");
  }
}

void appendEscaped(const std::string& value, std::string& out) {
  out.push_back('"');
  for (const char raw : value) {
    const unsigned char ch = static_cast<unsigned char>(raw);
    switch (ch) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (ch < 0x20 || ch >= 0x7F) {
          // Escape control characters and every non-ASCII byte, so the emitted
          // document stays valid regardless of the input's encoding.
          static const char* kHex = "0123456789abcdef";
          out += "\\u00";
          out.push_back(kHex[(ch >> 4) & 0x0F]);
          out.push_back(kHex[ch & 0x0F]);
        } else {
          out.push_back(raw);
        }
        break;
    }
  }
  out.push_back('"');
}

void Writer::separate() {
  if (!first_) buffer_.push_back(',');
  first_ = false;
}

Writer& Writer::key(const char* name) {
  separate();
  appendEscaped(name, buffer_);
  buffer_.push_back(':');
  return *this;
}

Writer& Writer::string(const char* name, const std::string& value) {
  key(name);
  appendEscaped(value, buffer_);
  return *this;
}

Writer& Writer::number(const char* name, std::uint64_t value) {
  key(name);
  buffer_ += std::to_string(value);
  return *this;
}

Writer& Writer::boolean(const char* name, bool value) {
  key(name);
  buffer_ += value ? "true" : "false";
  return *this;
}

std::string Writer::finish() {
  buffer_.push_back('}');
  std::string result;
  result.swap(buffer_);
  buffer_ = "{";
  first_ = true;
  return result;
}

}  // namespace json
}  // namespace netsuflow
