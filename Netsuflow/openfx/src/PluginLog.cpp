#include "PluginLog.hpp"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <sstream>
#include <thread>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace netsuflow {
namespace log {
namespace {

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

std::int64_t processId() noexcept {
#if defined(_WIN32)
  return static_cast<std::int64_t>(::GetCurrentProcessId());
#else
  return static_cast<std::int64_t>(::getpid());
#endif
}

void createDirectories(const std::string& directory) {
  if (directory.empty()) return;
  std::string partial;
  partial.reserve(directory.size());
  for (std::size_t i = 0; i < directory.size(); ++i) {
    const char ch = directory[i];
    partial.push_back(ch);
    const bool separator = (ch == '/' || ch == '\\');
    if (!separator && i + 1 != directory.size()) continue;
    if (partial.size() <= 1) continue;
#if defined(_WIN32)
    if (partial.size() == 3 && partial[1] == ':') continue;  // drive root
    ::CreateDirectoryA(partial.c_str(), nullptr);
#else
    ::mkdir(partial.c_str(), 0700);
#endif
  }
}

struct State {
  bool enabled = false;
  std::string path;
  std::mutex mutex;
};

State& state() noexcept {
  static State instance;
  static std::once_flag once;
  // call_once propagates whatever the callable throws, and enabled() is noexcept
  // and reachable from a destructor, so the setup cannot be allowed to throw.
  // Failing to open a log is never a reason to take the host down.
  std::call_once(once, [] {
    try {
      const std::string flag = environmentValue("NETSUFLOW_OFX_LOG");
      if (flag.empty() || flag == "0") return;

      std::string directory;
      if (flag != "1") {
        directory = flag;  // explicit directory
      } else {
#if defined(_WIN32)
        const std::string base = environmentValue("LOCALAPPDATA");
        if (base.empty()) return;
        directory = base + "\\NetsuRush\\netsuflow\\logs";
#else
        const std::string home = environmentValue("HOME");
        if (home.empty()) return;
        directory = home + "/.local/share/NetsuRush/netsuflow/logs";
#endif
      }
      createDirectories(directory);

      const char separator =
#if defined(_WIN32)
          '\\';
#else
          '/';
#endif
      instance.path = directory + separator + "ofx-" + std::to_string(processId()) + ".log";
      instance.enabled = true;
    } catch (...) {
      instance.enabled = false;
    }
  });
  return instance;
}

std::string timestamp() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  const auto micros = std::chrono::duration_cast<std::chrono::microseconds>(now).count();
  std::ostringstream out;
  out << micros;
  return out.str();
}

std::string threadId() {
  std::ostringstream out;
  out << std::this_thread::get_id();
  return out.str();
}

}  // namespace

bool enabled() noexcept { return state().enabled; }

const std::string& path() { return state().path; }

void write(const std::string& line) noexcept try {
  State& s = state();
  if (!s.enabled) return;
  std::lock_guard<std::mutex> guard(s.mutex);
  std::FILE* file = nullptr;
#if defined(_WIN32)
  if (fopen_s(&file, s.path.c_str(), "ab") != 0) file = nullptr;
#else
  file = std::fopen(s.path.c_str(), "ab");
#endif
  if (file == nullptr) return;
  std::fwrite(line.data(), 1, line.size(), file);
  std::fputc('\n', file);
  std::fclose(file);
} catch (...) {
  // Logging must never be the reason a render fails.
}

Line::Line(const char* action) {
  if (!enabled()) return;
  buffer_ = "t=" + timestamp() + " pid=" + std::to_string(processId()) + " thread=" + threadId() +
            " action=" + (action != nullptr ? action : "?");
}

Line& Line::add(const char* key, const std::string& value) {
  if (!enabled()) return *this;
  buffer_ += ' ';
  buffer_ += key;
  buffer_ += '=';
  buffer_ += value;
  return *this;
}

Line& Line::add(const char* key, std::int64_t value) {
  return add(key, std::to_string(value));
}

Line& Line::add(const char* key, double value) {
  std::ostringstream out;
  out << value;
  return add(key, out.str());
}

Line& Line::add(const char* key, bool value) {
  return add(key, std::string(value ? "true" : "false"));
}

void Line::commit() {
  if (committed_ || !enabled()) return;
  committed_ = true;
  write(buffer_);
}

}  // namespace log
}  // namespace netsuflow
