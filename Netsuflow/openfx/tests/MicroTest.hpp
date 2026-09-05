// Minimal self-contained test harness.
//
// The plugin proof must build from the Resolve SDK alone, with no network fetch
// and no vendored third-party test framework whose licence would have to be
// tracked. This header provides just enough of the familiar TEST_CASE/REQUIRE
// shape to express the proof's assertions.
#pragma once

#include <cstdio>
#include <cstdlib>
#include <exception>
#include <string>
#include <vector>

namespace microtest {

struct Case {
  const char* name;
  void (*fn)();
};

inline std::vector<Case>& registry() {
  static std::vector<Case> cases;
  return cases;
}

struct Registrar {
  Registrar(const char* name, void (*fn)()) { registry().push_back(Case{name, fn}); }
};

struct Failure : std::exception {
  std::string message;
  explicit Failure(std::string m) : message(std::move(m)) {}
  const char* what() const noexcept override { return message.c_str(); }
};

inline void fail(const char* file, int line, const char* expr) {
  throw Failure(std::string(file) + ":" + std::to_string(line) + ": REQUIRE(" + expr + ")");
}

inline int run() {
  int failed = 0;
  for (const Case& c : registry()) {
    try {
      c.fn();
      std::printf("[  ok  ] %s\n", c.name);
    } catch (const Failure& f) {
      std::printf("[ FAIL ] %s\n         %s\n", c.name, f.what());
      ++failed;
    } catch (const std::exception& e) {
      std::printf("[ FAIL ] %s\n         unexpected exception: %s\n", c.name, e.what());
      ++failed;
    } catch (...) {
      std::printf("[ FAIL ] %s\n         unexpected non-standard exception\n", c.name);
      ++failed;
    }
  }
  std::printf("%d case(s), %d failure(s)\n", static_cast<int>(registry().size()), failed);
  return failed == 0 ? 0 : 1;
}

}  // namespace microtest

#define MICROTEST_CONCAT_INNER(a, b) a##b
#define MICROTEST_CONCAT(a, b) MICROTEST_CONCAT_INNER(a, b)

#define TEST_CASE(name)                                                            \
  static void MICROTEST_CONCAT(microtest_case_, __LINE__)();                       \
  static ::microtest::Registrar MICROTEST_CONCAT(microtest_registrar_, __LINE__)(  \
      name, &MICROTEST_CONCAT(microtest_case_, __LINE__));                         \
  static void MICROTEST_CONCAT(microtest_case_, __LINE__)()

#define REQUIRE(expr)                                    \
  do {                                                   \
    if (!(expr)) ::microtest::fail(__FILE__, __LINE__, #expr); \
  } while (false)

#define MICROTEST_MAIN() \
  int main() { return ::microtest::run(); }
