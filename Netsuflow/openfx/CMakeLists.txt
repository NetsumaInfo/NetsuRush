cmake_minimum_required(VERSION 3.20)
project(NetsuFlowOpenFX LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_LIST_DIR}/cmake")

option(NETSUFLOW_BUILD_TESTS "Build the NetsuFlow OpenFX unit tests" ON)
option(NETSUFLOW_BUILD_PLUGIN "Build the OpenFX plugin bundle (requires the Resolve SDK)" ON)

if(MSVC)
  add_compile_options(/utf-8)
  # Static CRT: the .ofx is loaded into a host we do not install alongside, so it
  # must not depend on a Visual C++ redistributable being present. Nothing is
  # passed across the plugin boundary that would care (the OpenFX ABI is C, and
  # the host owns its own image buffers).
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  # Reproducible output: /Brepro replaces the PE timestamp and other volatile
  # fields with a content hash, so two clean builds of the same sources produce
  # the same binary. The packaging contract in docs/09 records checksums, and a
  # checksum only means something if the build is deterministic.
  add_compile_options(/Brepro)
  add_link_options(/Brepro)
endif()

# ---------------------------------------------------------------------------
# netsuflow_core: host-independent logic, buildable and testable without the SDK
# ---------------------------------------------------------------------------

add_library(netsuflow_core STATIC
  src/DiagnosticFrame.cpp
  src/MiniJson.cpp
  src/Protocol.cpp
  src/SessionDescriptor.cpp
  src/BridgeClient.cpp
  src/PluginLog.cpp)

target_include_directories(netsuflow_core PUBLIC "${CMAKE_CURRENT_LIST_DIR}/src")

if(WIN32)
  target_link_libraries(netsuflow_core PUBLIC ws2_32)
  target_compile_definitions(netsuflow_core PUBLIC WIN32_LEAN_AND_MEAN NOMINMAX)
endif()

if(MSVC)
  target_compile_options(netsuflow_core PRIVATE /W4 /WX /permissive-)
else()
  target_compile_options(netsuflow_core PRIVATE -Wall -Wextra -Werror)
endif()

# ---------------------------------------------------------------------------
# Plugin bundle
# ---------------------------------------------------------------------------

if(NETSUFLOW_BUILD_PLUGIN)
  find_package(ResolveOpenFX REQUIRED)

  add_library(netsuflow_ofx_support STATIC ${ResolveOpenFX_SUPPORT_SOURCES})
  target_include_directories(netsuflow_ofx_support PUBLIC ${ResolveOpenFX_INCLUDE_DIRS})
  set_target_properties(netsuflow_ofx_support PROPERTIES POSITION_INDEPENDENT_CODE ON)
  if(MSVC)
    # Vendor sources: compiled as shipped, warnings not escalated.
    target_compile_options(netsuflow_ofx_support PRIVATE /W0)
    target_compile_definitions(netsuflow_ofx_support PUBLIC _CRT_SECURE_NO_WARNINGS)
  else()
    target_compile_options(netsuflow_ofx_support PRIVATE -w)
  endif()

  add_library(NetsuFlow MODULE
    src/PluginMain.cpp
    src/NetsuFlowGenerator.cpp)
  target_link_libraries(NetsuFlow PRIVATE netsuflow_core netsuflow_ofx_support)
  if(WIN32)
    # ShellExecuteW, so opening the editor never spawns a console window.
    target_link_libraries(NetsuFlow PRIVATE shell32)
  endif()
  set_target_properties(NetsuFlow PROPERTIES
    PREFIX ""
    OUTPUT_NAME "NetsuFlow"
    SUFFIX ".ofx")
  if(MSVC)
    target_compile_options(NetsuFlow PRIVATE /W4 /permissive-)
  endif()

  # Bundle architecture directory, per the OpenFX packaging specification and the
  # Resolve SDK README.
  if(WIN32)
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
      set(NETSUFLOW_BUNDLE_ARCH "Win64")
    else()
      set(NETSUFLOW_BUNDLE_ARCH "Win32")
    endif()
  elseif(APPLE)
    set(NETSUFLOW_BUNDLE_ARCH "MacOS")
  else()
    set(NETSUFLOW_BUNDLE_ARCH "Linux-x86-64")
  endif()

  set(NETSUFLOW_BUNDLE_DIR "$<TARGET_FILE_DIR:NetsuFlow>/NetsuFlow.ofx.bundle")

  add_custom_command(TARGET NetsuFlow POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory
            "${NETSUFLOW_BUNDLE_DIR}/Contents/${NETSUFLOW_BUNDLE_ARCH}"
    COMMAND ${CMAKE_COMMAND} -E make_directory
            "${NETSUFLOW_BUNDLE_DIR}/Contents/Resources"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:NetsuFlow>"
            "${NETSUFLOW_BUNDLE_DIR}/Contents/${NETSUFLOW_BUNDLE_ARCH}/NetsuFlow.ofx"
    COMMENT "Assembling NetsuFlow.ofx.bundle (${NETSUFLOW_BUNDLE_ARCH})"
    VERBATIM)
endif()

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

if(NETSUFLOW_BUILD_TESTS)
  enable_testing()

  function(netsuflow_add_test name source)
    add_executable(${name} ${source})
    target_link_libraries(${name} PRIVATE netsuflow_core)
    target_include_directories(${name} PRIVATE "${CMAKE_CURRENT_LIST_DIR}/tests")
    if(MSVC)
      target_compile_options(${name} PRIVATE /W4 /WX /permissive-)
    else()
      target_compile_options(${name} PRIVATE -Wall -Wextra -Werror)
    endif()
    add_test(NAME ${name} COMMAND ${name})
  endfunction()

  netsuflow_add_test(DiagnosticFrameTests tests/DiagnosticFrameTests.cpp)
  netsuflow_add_test(ProtocolTests tests/ProtocolTests.cpp)
  netsuflow_add_test(SessionDescriptorTests tests/SessionDescriptorTests.cpp)

  # End-to-end check against the Node fake renderer. Registered only when Node is
  # available so a machine without it still gets a green unit-test run.
  find_program(NETSUFLOW_NODE_EXECUTABLE NAMES node node.exe)
  add_executable(BridgeClientHarness tests/BridgeClientHarness.cpp)
  target_link_libraries(BridgeClientHarness PRIVATE netsuflow_core)
  if(WIN32)
    target_link_libraries(BridgeClientHarness PRIVATE psapi)
  endif()
  target_include_directories(BridgeClientHarness PRIVATE "${CMAKE_CURRENT_LIST_DIR}/tests")
  if(MSVC)
    target_compile_options(BridgeClientHarness PRIVATE /W4 /WX /permissive-)
  else()
    target_compile_options(BridgeClientHarness PRIVATE -Wall -Wextra -Werror)
  endif()

  if(NETSUFLOW_NODE_EXECUTABLE)
    add_test(NAME BridgeEndToEnd
      COMMAND "${NETSUFLOW_NODE_EXECUTABLE}"
              "${CMAKE_CURRENT_LIST_DIR}/../prototypes/fake-renderer/e2e/bridge-e2e.mjs"
              "$<TARGET_FILE:BridgeClientHarness>")
    # The soak scenario issues NETSUFLOW_E2E_SOAK requests (10,000 by default,
    # which is what T03 asks for), so the budget is generous on purpose.
    set_tests_properties(BridgeEndToEnd PROPERTIES TIMEOUT 1800)
  else()
    message(STATUS "node was not found: the BridgeEndToEnd test is not registered")
  endif()
endif()
