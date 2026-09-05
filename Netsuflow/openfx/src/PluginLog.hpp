// Instrumented logging for the host-proof runs.
//
// T01 and T07 need the host's actual call pattern: which actions arrive, at what
// times, on which threads, with which render windows, and whether abort was
// observed. Nothing about the user's project is recorded: no source text, no
// props, no tokens, no file paths beyond the log's own.
#pragma once

#include <cstdint>
#include <string>

namespace netsuflow {
namespace log {

/// Enabled when NETSUFLOW_OFX_LOG is set to a non-empty, non-"0" value.
bool enabled() noexcept;

/// Absolute path of the active log file, or an empty string when disabled.
const std::string& path();

void write(const std::string& line) noexcept;

/// Appends `key=value` pairs; convenience for the render action's hot path.
class Line {
 public:
  explicit Line(const char* action);
  Line& add(const char* key, const std::string& value);
  Line& add(const char* key, std::int64_t value);
  Line& add(const char* key, double value);
  Line& add(const char* key, bool value);
  void commit();

 private:
  std::string buffer_;
  bool committed_ = false;
};

}  // namespace log
}  // namespace netsuflow
