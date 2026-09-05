// Bounded parser and writer for the flat JSON objects used by the bridge.
//
// The renderer service is untrusted input from the plugin's point of view, so
// this parser deliberately accepts only a flat object of scalar values. Nested
// objects and arrays are rejected rather than walked, which removes recursion
// and unbounded structure from the attack surface entirely.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace netsuflow {
namespace json {

inline constexpr std::size_t kMaxDocumentBytes = 64u * 1024u;
inline constexpr std::size_t kMaxKeys = 64;
inline constexpr std::size_t kMaxStringBytes = 8192;
inline constexpr std::size_t kMaxNumberChars = 40;

enum class ValueType { Null, Bool, Number, String };

struct Value {
  ValueType type = ValueType::Null;
  bool boolean = false;
  std::string text;  // string contents, or the raw numeric token
};

class Object {
 public:
  bool has(const char* key) const noexcept;
  bool getString(const char* key, std::string& out) const;
  bool getUint32(const char* key, std::uint32_t& out) const;
  bool getUint64(const char* key, std::uint64_t& out) const;
  bool getBool(const char* key, bool& out) const;
  std::size_t size() const noexcept { return entries_.size(); }
  void clear() noexcept { entries_.clear(); }
  void insert(std::string key, Value value);

 private:
  const Value* find(const char* key) const noexcept;
  std::vector<std::pair<std::string, Value>> entries_;
};

/// Parses a flat JSON object. Returns false on any malformed, oversized, or
/// structurally nested input. `error` is optional and never contains payload
/// bytes, only a fixed reason.
bool parseFlatObject(const char* data, std::size_t size, Object& out, const char** error) noexcept;

/// Appends `value` to `out` as a JSON string literal, escaping control
/// characters and quoting. Invalid UTF-8 bytes are escaped rather than copied.
void appendEscaped(const std::string& value, std::string& out);

/// Minimal writer for the flat objects the plugin emits.
class Writer {
 public:
  Writer& key(const char* name);
  Writer& string(const char* name, const std::string& value);
  Writer& number(const char* name, std::uint64_t value);
  Writer& boolean(const char* name, bool value);
  std::string finish();

 private:
  void separate();
  std::string buffer_ = "{";
  bool first_ = true;
};

}  // namespace json
}  // namespace netsuflow
