# Locates the OpenFX 1.4 headers and the OpenFX C++ Support wrapper shipped with
# the DaVinci Resolve Developer SDK.
#
# The SDK is never copied into this repository. Point DAVINCI_RESOLVE_DEVELOPER_DIR
# at the installed SDK, or rely on the default platform location.
#
# Defines:
#   ResolveOpenFX_FOUND
#   ResolveOpenFX_INCLUDE_DIRS   OpenFX 1.4 + Support headers
#   ResolveOpenFX_SUPPORT_SOURCES  Support library translation units
#   ResolveOpenFX_ROOT           the resolved OpenFX directory inside the SDK

set(_nf_sdk_hints "")

if(DEFINED DAVINCI_RESOLVE_DEVELOPER_DIR)
  list(APPEND _nf_sdk_hints "${DAVINCI_RESOLVE_DEVELOPER_DIR}")
endif()
if(DEFINED ENV{DAVINCI_RESOLVE_DEVELOPER_DIR})
  list(APPEND _nf_sdk_hints "$ENV{DAVINCI_RESOLVE_DEVELOPER_DIR}")
endif()

if(WIN32)
  list(APPEND _nf_sdk_hints
    "C:/ProgramData/Blackmagic Design/DaVinci Resolve/Support/Developer")
elseif(APPLE)
  list(APPEND _nf_sdk_hints
    "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer")
else()
  list(APPEND _nf_sdk_hints
    "/opt/resolve/Developer")
endif()

set(ResolveOpenFX_ROOT "" CACHE PATH "OpenFX directory inside the Resolve Developer SDK")

foreach(_hint IN LISTS _nf_sdk_hints)
  if(ResolveOpenFX_ROOT)
    break()
  endif()
  foreach(_candidate "${_hint}/OpenFX" "${_hint}")
    if(EXISTS "${_candidate}/OpenFX-1.4/include/ofxImageEffect.h"
       AND EXISTS "${_candidate}/Support/include/ofxsImageEffect.h")
      set(ResolveOpenFX_ROOT "${_candidate}" CACHE PATH "" FORCE)
      break()
    endif()
  endforeach()
endforeach()

set(ResolveOpenFX_SUPPORT_SOURCES "")
set(ResolveOpenFX_INCLUDE_DIRS "")

if(ResolveOpenFX_ROOT)
  set(ResolveOpenFX_INCLUDE_DIRS
    "${ResolveOpenFX_ROOT}/OpenFX-1.4/include"
    "${ResolveOpenFX_ROOT}/Support/include")

  # This is the exact translation-unit list the SDK's own sample projects build.
  # ofxsHWNDInteract.cpp is deliberately excluded: the shipped drop does not
  # include the ofxHWNDInteract.h header it needs, and the samples do not compile
  # it either.
  set(_nf_support_units
    ofxsCore.cpp
    ofxsImageEffect.cpp
    ofxsInteract.cpp
    ofxsLog.cpp
    ofxsMultiThread.cpp
    ofxsParams.cpp
    ofxsProperty.cpp
    ofxsPropertyValidation.cpp)

  foreach(_unit IN LISTS _nf_support_units)
    set(_path "${ResolveOpenFX_ROOT}/Support/Library/${_unit}")
    if(NOT EXISTS "${_path}")
      message(FATAL_ERROR
        "Resolve OpenFX Support library is incomplete: missing ${_path}. "
        "Reinstall the DaVinci Resolve Developer SDK.")
    endif()
    list(APPEND ResolveOpenFX_SUPPORT_SOURCES "${_path}")
  endforeach()
endif()

include(FindPackageHandleStandardArgs)
find_package_handle_standard_args(ResolveOpenFX
  REQUIRED_VARS ResolveOpenFX_ROOT ResolveOpenFX_INCLUDE_DIRS ResolveOpenFX_SUPPORT_SOURCES
  FAIL_MESSAGE
    "OpenFX 1.4 headers and the C++ Support wrapper were not found. Install the DaVinci Resolve Developer SDK and set DAVINCI_RESOLVE_DEVELOPER_DIR to its Developer directory (the one containing OpenFX/).")
