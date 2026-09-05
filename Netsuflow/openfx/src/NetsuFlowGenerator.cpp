#include "NetsuFlowGenerator.hpp"

#ifdef _WIN32
#include <windows.h>
#endif

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <vector>

#if defined(_WIN32)
// Reaching the shell's URL handler without a shell. Included before the plugin
// headers because windows.h defines min/max macros the SDK headers work around.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#else
#include <unistd.h>
#endif

#include "DiagnosticFrame.hpp"
#include "PluginLog.hpp"
#include "SessionDescriptor.hpp"

namespace netsuflow {
namespace {

const char* const kPluginName = "NetsuFlow (Experimental)";
const char* const kPluginGrouping = "NetsuFlow";
const char* const kPluginDescription =
    "Renders a web-motion composition through the NetsuRush renderer service. Paste composition "
    "HTML into Code, or let NetsuRush drive the node through a binding.";
// Never change this. Resolve projects store the identifier, not the visible
// name, so renaming above is safe and renaming here would orphan every node
// already placed in a timeline.
const char* const kPluginIdentifier = "com.netsurush.netsuflow.generator";
constexpr int kPluginVersionMajor = 0;
constexpr int kPluginVersionMinor = 2;

constexpr bool kSupportsTiles = false;
constexpr bool kSupportsMultiResolution = false;

const char* const kParamSource = "source";
const char* const kParamCode = "code";
const char* const kParamBinding = "binding";
const char* const kParamStartFrame = "startFrame";
const char* const kParamQuality = "quality";
const char* const kParamFormat = "format";
const char* const kParamCustomSize = "customSize";
const char* const kParamFit = "fit";
const char* const kParamReload = "reload";
const char* const kParamOpenEditor = "openEditor";
const char* const kParamStatus = "status";
const char* const kGroupComposition = "compositionGroup";

/// The binding name the service reserves for the spooled Code field.
const char* const kPasteBinding = "paste";

/// Colour written when a frame cannot be produced and no last-good frame exists.
constexpr std::uint8_t kErrorColour[4] = {255, 0, 128, 255};

/// Bilinear sample of a straight-alpha RGBA8 buffer, in pixel-centre
/// coordinates. Out-of-range samples are transparent rather than clamped: a
/// composition letterboxed into a wider frame must leave the bars empty for the
/// host to composite over, not smeared with its own edge pixels.
///
/// Sampling straight alpha directly is only correct because it is straight:
/// interpolating premultiplied colour would drag the colour of transparent
/// neighbours into an edge. Premultiplication happens after, once.
void sampleBilinear(const std::uint8_t* buffer, std::uint32_t width, std::uint32_t height,
                    double x, double y, std::uint8_t out[4]) {
  const double left = std::floor(x);
  const double top = std::floor(y);
  const double fx = x - left;
  const double fy = y - top;

  double accumulator[4] = {0.0, 0.0, 0.0, 0.0};
  for (int dy = 0; dy < 2; ++dy) {
    for (int dx = 0; dx < 2; ++dx) {
      const double weight = (dx == 0 ? 1.0 - fx : fx) * (dy == 0 ? 1.0 - fy : fy);
      if (weight <= 0.0) continue;
      const double sx = left + dx;
      const double sy = top + dy;
      if (sx < 0.0 || sy < 0.0 || sx >= static_cast<double>(width) ||
          sy >= static_cast<double>(height)) {
        continue;  // contributes zero, which is transparent black
      }
      const std::uint8_t* pixel =
          buffer + ((static_cast<std::size_t>(sy) * width) + static_cast<std::size_t>(sx)) * 4u;
      for (int c = 0; c < 4; ++c) accumulator[c] += weight * pixel[c];
    }
  }
  for (int c = 0; c < 4; ++c) {
    const long rounded = std::lround(accumulator[c]);
    out[c] = static_cast<std::uint8_t>(std::clamp<long>(rounded, 0, 255));
  }
}

/// Maps a composition of one size onto a frame of another.
struct FitTransform {
  double scaleX = 1.0;
  double scaleY = 1.0;
  double offsetX = 0.0;
  double offsetY = 0.0;
  bool identity = false;
};

FitTransform computeFit(FitMode mode, std::uint32_t sourceWidth, std::uint32_t sourceHeight,
                        std::uint32_t destinationWidth, std::uint32_t destinationHeight) {
  FitTransform fit;
  if (sourceWidth == 0 || sourceHeight == 0) return fit;

  const double sw = static_cast<double>(sourceWidth);
  const double sh = static_cast<double>(sourceHeight);
  const double dw = static_cast<double>(destinationWidth);
  const double dh = static_cast<double>(destinationHeight);

  switch (mode) {
    case FitMode::Stretch:
      fit.scaleX = dw / sw;
      fit.scaleY = dh / sh;
      break;
    case FitMode::Cover:
      fit.scaleX = fit.scaleY = (std::max)(dw / sw, dh / sh);
      break;
    case FitMode::Actual:
      fit.scaleX = fit.scaleY = 1.0;
      break;
    case FitMode::Contain:
    default:
      fit.scaleX = fit.scaleY = (std::min)(dw / sw, dh / sh);
      break;
  }
  fit.offsetX = (dw - sw * fit.scaleX) * 0.5;
  fit.offsetY = (dh - sh * fit.scaleY) * 0.5;
  // The overwhelmingly common case is a composition authored at the timeline's
  // size, and it must not pay for a resampler that would do nothing.
  fit.identity = sourceWidth == destinationWidth && sourceHeight == destinationHeight &&
                 std::abs(fit.scaleX - 1.0) < 1e-9 && std::abs(fit.scaleY - 1.0) < 1e-9 &&
                 std::abs(fit.offsetX) < 1e-9 && std::abs(fit.offsetY) < 1e-9;
  return fit;
}

std::string makeInstanceId() {
  static std::atomic<std::uint32_t> counter{0};
  return "ofx-" + std::to_string(counter.fetch_add(1));
}

void fillSolid(std::vector<std::uint8_t>& buffer, std::size_t pixelCount,
               const std::uint8_t colour[4]) {
  buffer.assign(pixelCount * 4u, 0);
  for (std::size_t i = 0; i < pixelCount; ++i) {
    std::memcpy(buffer.data() + i * 4u, colour, 4);
  }
}

class HostAbortSignal : public AbortSignal {
 public:
  explicit HostAbortSignal(const OFX::ImageEffect& effect) : effect_(effect) {}
  bool aborted() const override { return effect_.abort(); }

 private:
  const OFX::ImageEffect& effect_;
};

int choiceValueAtTime(OFX::ChoiceParam* param, double time, int fallback) {
  if (param == nullptr) return fallback;
  int value = fallback;
  param->getValueAtTime(time, value);
  return value;
}

/// %LOCALAPPDATA%\NetsuRush\netsuflow\paste — beside the session descriptor, so
/// both sides derive it without configuration.
std::filesystem::path spoolDirectory() {
  const std::string descriptor = defaultSessionDescriptorPath();
  if (descriptor.empty()) return {};
  return std::filesystem::path(descriptor).parent_path() / "paste";
}

/// The size the editor last sent, written beside the revision. Zero when the
/// editor has never sent, which is not an error: DESCRIBE answers the same
/// question a moment later, and the host's own frame is the last resort.
void readEditorSize(std::uint32_t& width, std::uint32_t& height) {
  width = 0;
  height = 0;
  const std::filesystem::path directory = spoolDirectory();
  if (directory.empty()) return;
  std::ifstream file(directory / "size.txt", std::ios::binary);
  if (!file) return;
  std::string text;
  file >> text;
  unsigned w = 0;
  unsigned h = 0;
  if (std::sscanf(text.c_str(), "%ux%u", &w, &h) != 2) return;
  if (w == 0 || h == 0 || w > 16384 || h > 16384) return;
  width = w;
  height = h;
}

/// Reads the revision the editor's Send button stamped, or an empty string if
/// nothing has been sent yet.
///
/// This is the whole of the editor handshake, and it is one file on purpose.
/// The editor writes the spool continuously while the user types, because that
/// is what the preview reads; if the node keyed on the spool it would re-render
/// on every keystroke. Keying on a separate file makes Send an actual decision:
/// the node's picture changes when asked and holds still otherwise.
std::string readEditorRevision() {
  const std::filesystem::path directory = spoolDirectory();
  if (directory.empty()) return {};
  std::ifstream file(directory / "revision.txt", std::ios::binary);
  if (!file) return {};
  std::string revision;
  file >> revision;
  // A 64-bit FNV hash in hex, and nothing longer is a revision this wrote.
  if (revision.size() > 16) revision.resize(16);
  return revision;
}

/// The plugin follows the OS display language, the same default Resolve
/// follows. Labels and hints only: option order, parameter names and option
/// indices are the saved-project contract and never vary with locale.
bool uiIsFrench() {
#ifdef _WIN32
  return (GetUserDefaultUILanguage() & 0x3FF) == LANG_FRENCH;
#else
  const char* lang = std::getenv("LANG");
  return lang != nullptr && std::strncmp(lang, "fr", 2) == 0;
#endif
}

const char* tr(const char* english, const char* french) {
  static const bool frenchUi = uiIsFrench();
  return frenchUi ? french : english;
}

/// Comma-separated wire lists (enum options and their labels).
std::vector<std::string> splitList(const std::string& packed) {
  std::vector<std::string> out;
  if (packed.empty()) return out;
  std::size_t start = 0;
  for (std::size_t at = 0; at <= packed.size(); ++at) {
    if (at == packed.size() || packed[at] == ',') {
      out.push_back(packed.substr(start, at - start));
      start = at + 1;
    }
  }
  return out;
}

std::string formatNumber(double value) {
  char out[64];
  std::snprintf(out, sizeof out, "%.6g", value);
  return std::string(out);
}

std::string formatColour(double r, double g, double b) {
  const auto channel = [](double v) {
    const long rounded = std::lround(std::clamp(v, 0.0, 1.0) * 255.0);
    return static_cast<unsigned>(rounded);
  };
  char out[8];
  std::snprintf(out, sizeof out, "#%02x%02x%02x", channel(r), channel(g), channel(b));
  return std::string(out);
}

/// Parses "#rrggbb" into 0..1 channels. Returns false for anything else; a
/// composition may default a colour variable to a CSS keyword this cannot
/// honour, and leaving the control untouched is better than guessing.
bool parseColour(const std::string& text, double& r, double& g, double& b) {
  if (text.size() != 7 || text[0] != '#') return false;
  unsigned rr = 0, gg = 0, bb = 0;
  if (std::sscanf(text.c_str() + 1, "%02x%02x%02x", &rr, &gg, &bb) != 3) return false;
  r = rr / 255.0;
  g = gg / 255.0;
  b = bb / 255.0;
  return true;
}

/// Hands a loopback URL to the desktop's default browser.
///
/// No shell is involved anywhere. On Windows `ShellExecuteW` is called
/// directly rather than through `std::system`, which would spawn `cmd.exe` and
/// leave a console window on screen for every click — the whole reason this is
/// not a one-line `system()` call.
///
/// The port is an integer this process just read from its own session
/// descriptor and the rest of the URL is a literal, so nothing user-supplied
/// reaches the call either way.
void openEditor(std::uint16_t port) {
  const std::string url = "http://127.0.0.1:" + std::to_string(port) + "/";
#if defined(_WIN32)
  const std::wstring wide(url.begin(), url.end());  // the URL is ASCII by construction
  ::ShellExecuteW(nullptr, L"open", wide.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
#else
#if defined(__APPLE__)
  const char* const opener = "/usr/bin/open";
#else
  const char* const opener = "/usr/bin/xdg-open";
#endif
  const pid_t child = ::fork();
  if (child == 0) {
    ::execl(opener, opener, url.c_str(), static_cast<char*>(nullptr));
    ::_exit(127);
  }
#endif
}

}  // namespace

NetsuFlowGenerator::NetsuFlowGenerator(OfxImageEffectHandle handle)
    : OFX::ImageEffect(handle), instanceId_(makeInstanceId()) {
  dstClip_ = fetchClip(kOfxImageEffectOutputClipName);

  source_ = fetchChoiceParam(kParamSource);
  code_ = fetchStringParam(kParamCode);
  binding_ = fetchStringParam(kParamBinding);
  status_ = fetchStringParam(kParamStatus);
  startFrame_ = fetchIntParam(kParamStartFrame);
  quality_ = fetchChoiceParam(kParamQuality);
  format_ = fetchChoiceParam(kParamFormat);
  customSize_ = fetchInt2DParam(kParamCustomSize);
  fit_ = fetchChoiceParam(kParamFit);

  for (int i = 0; i < kPoolNumbers; ++i) {
    poolNumbers_[i] = fetchDoubleParam("nfNum" + std::to_string(i));
  }
  for (int i = 0; i < kPoolTexts; ++i) {
    poolTexts_[i] = fetchStringParam("nfText" + std::to_string(i));
  }
  for (int i = 0; i < kPoolColors; ++i) {
    poolColors_[i] = fetchRGBParam("nfColor" + std::to_string(i));
  }
  for (int i = 0; i < kPoolBooleans; ++i) {
    poolBooleans_[i] = fetchBooleanParam("nfBool" + std::to_string(i));
  }
  for (int i = 0; i < kPoolChoices; ++i) {
    poolChoices_[i] = fetchChoiceParam("nfChoice" + std::to_string(i));
  }

  log::Line("instanceCreated").add("instance", instanceId_).commit();
}

NetsuFlowGenerator::~NetsuFlowGenerator() {
  try {
    log::Line("instanceDestroyed").add("instance", instanceId_).commit();
  } catch (...) {
    // Losing a log line during teardown is not worth taking the host down for.
  }
}

std::uint32_t NetsuFlowGenerator::resolveSourceFrame(double time) const {
  const int startFrame = startFrame_ != nullptr ? startFrame_->getValueAtTime(time) : 0;
  const double hostFrame = std::floor(time);
  const double sourceFrame = hostFrame - static_cast<double>(startFrame);
  if (!(sourceFrame >= 0.0)) return 0;  // also catches NaN
  if (sourceFrame > 4294967294.0) return 4294967294u;
  return static_cast<std::uint32_t>(sourceFrame);
}

GeneratorSource NetsuFlowGenerator::sourceAtTime(double time) const {
  switch (choiceValueAtTime(source_, time, 0)) {
    case 1:
      return GeneratorSource::Editor;
    case 2:
      return GeneratorSource::NetsuRush;
    default:
      return GeneratorSource::Code;
  }
}

std::string NetsuFlowGenerator::bindingForSource(GeneratorSource source, double time) const {
  // Both spool-backed modes talk to the same binding: they differ only in who
  // decides when its revision changes.
  if (source == GeneratorSource::Code || source == GeneratorSource::Editor) return kPasteBinding;
  std::string binding;
  if (binding_ != nullptr) binding_->getValueAtTime(time, binding);
  return binding;
}

void NetsuFlowGenerator::requestedSize(double time, std::uint32_t hostWidth,
                                       std::uint32_t hostHeight, std::uint32_t& outWidth,
                                       std::uint32_t& outHeight) const {
  outWidth = hostWidth;
  outHeight = hostHeight;

  const auto take = [&](std::uint32_t w, std::uint32_t h) {
    if (w == 0 || h == 0) return false;
    outWidth = w;
    outHeight = h;
    return true;
  };

  switch (static_cast<FormatSource>(choiceValueAtTime(format_, time, 0))) {
    case FormatSource::Custom: {
      if (customSize_ == nullptr) break;
      int w = 0;
      int h = 0;
      customSize_->getValueAtTime(time, w, h);
      if (w >= 16 && h >= 16 && w <= 16384 && h <= 16384) {
        take(static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h));
      }
      break;
    }

    case FormatSource::Composition:
      // Whatever the service is bound to right now, which the editor may have
      // overridden. Falls back to the code's own declaration, then to the size
      // the editor last sent.
      if (take(compositionWidth_.load(), compositionHeight_.load())) break;
      if (take(codeWidth_.load(), codeHeight_.load())) break;
      break;

    case FormatSource::Code:
    default: {
      // The size the pasted code declares for itself, whatever anyone has since
      // overridden. This is the one that follows the composition rather than
      // the session, which is what makes a portrait piece stay portrait after
      // someone has been trying formats in the editor.
      if (take(codeWidth_.load(), codeHeight_.load())) break;
      if (take(compositionWidth_.load(), compositionHeight_.load())) break;
      std::uint32_t sentWidth = 0;
      std::uint32_t sentHeight = 0;
      readEditorSize(sentWidth, sentHeight);
      take(sentWidth, sentHeight);
      break;
    }
  }
}

std::string NetsuFlowGenerator::codeHashForRender(double time) {
  std::lock_guard<std::mutex> lock(codeMutex_);
  if (!codeDirty_) return codeHashCache_;
  if (code_ == nullptr) return {};

  // Self-healing spool: a project reopened on another day carries its Code in
  // the param, but the spool file on disk is whatever the last session left.
  std::string code;
  code_->getValueAtTime(time, code);
  codeHashCache_ = code.empty() ? std::string() : writeSpool(code);
  codeDirty_ = false;
  return codeHashCache_;
}

std::string NetsuFlowGenerator::writeSpool(const std::string& code) {
  const std::string hash = protocol::fnv1a64Hex(code);
  {
    std::lock_guard<std::mutex> lock(spoolMutex_);
    if (hash == spooledHash_) return hash;
  }

  const std::filesystem::path directory = spoolDirectory();
  if (directory.empty()) return hash;

  std::error_code ignored;
  std::filesystem::create_directories(directory, ignored);

  // Write-then-rename, so the service can never read a half-written page.
  const std::filesystem::path target = directory / "index.html";
  const std::filesystem::path temporary = directory / ("index." + hash + ".tmp");
  {
    std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
    if (!out) return hash;
    out.write(code.data(), static_cast<std::streamsize>(code.size()));
    if (!out) return hash;
  }
  std::filesystem::rename(temporary, target, ignored);
  if (ignored) {
    // A rename across an open handle can fail on Windows; fall back to a plain
    // rewrite, which the service's rehash-on-mismatch tolerates.
    std::ofstream out(target, std::ios::binary | std::ios::trunc);
    out.write(code.data(), static_cast<std::streamsize>(code.size()));
    std::filesystem::remove(temporary, ignored);
  }

  {
    std::lock_guard<std::mutex> lock(spoolMutex_);
    spooledHash_ = hash;
  }
  return hash;
}

void NetsuFlowGenerator::applyVariableMapping(const std::vector<DescribedVariable>& declared) {
  std::vector<VariableSlot> mapping;
  int numbersUsed = 0;
  int textsUsed = 0;
  int coloursUsed = 0;
  int booleansUsed = 0;
  int choicesUsed = 0;

  // Previous assignment per control, so switching compositions resets defaults
  // but tweaking one and pressing Reload does not stomp the user's values.
  std::vector<VariableSlot> previous;
  {
    std::lock_guard<std::mutex> lock(variableMutex_);
    previous = variableMap_;
  }
  const auto previouslyHeld = [&previous](const VariableSlot::Kind kind, const int index,
                                          const std::string& id) {
    for (const VariableSlot& slot : previous) {
      if (slot.kind == kind && slot.index == index) return slot.id == id;
    }
    return false;
  };

  for (const DescribedVariable& variable : declared) {
    VariableSlot slot;
    slot.id = variable.id;
    const std::string label = variable.label.empty() ? variable.id : variable.label;

    if (variable.type == "number" && numbersUsed < kPoolNumbers) {
      slot.kind = VariableSlot::Kind::Number;
      slot.index = numbersUsed++;
      OFX::DoubleParam* param = poolNumbers_[slot.index];
      // The unit rides in the label — "Marge (px)" — because a bare Double
      // slot has nowhere else to say what its number means.
      param->setLabel(variable.unit.empty() ? label : label + " (" + variable.unit + ")");
      param->setIsSecret(false);
      param->setEnabled(true);
      double min = 0.0, max = 100.0;
      try {
        if (!variable.min.empty()) min = std::stod(variable.min);
        if (!variable.max.empty()) max = std::stod(variable.max);
      } catch (...) {
      }
      if (max > min) {
        param->setRange(min, max);
        param->setDisplayRange(min, max);
      }
      if (!previouslyHeld(slot.kind, slot.index, slot.id)) {
        try {
          if (!variable.defaultValue.empty()) param->setValue(std::stod(variable.defaultValue));
        } catch (...) {
        }
      }
    } else if (variable.type == "boolean" && booleansUsed < kPoolBooleans) {
      slot.kind = VariableSlot::Kind::Boolean;
      slot.index = booleansUsed++;
      OFX::BooleanParam* param = poolBooleans_[slot.index];
      param->setLabel(label);
      param->setIsSecret(false);
      param->setEnabled(true);
      if (!previouslyHeld(slot.kind, slot.index, slot.id)) {
        param->setValue(variable.defaultValue == "true" || variable.defaultValue == "1");
      }
    } else if (variable.type == "color" && coloursUsed < kPoolColors) {
      slot.kind = VariableSlot::Kind::Color;
      slot.index = coloursUsed++;
      OFX::RGBParam* param = poolColors_[slot.index];
      param->setLabel(label);
      param->setIsSecret(false);
      param->setEnabled(true);
      double r = 0, g = 0, b = 0;
      if (!previouslyHeld(slot.kind, slot.index, slot.id) &&
          parseColour(variable.defaultValue, r, g, b)) {
        param->setValue(r, g, b);
      }
    } else if (variable.type == "enum" && !variable.options.empty() &&
               choicesUsed < kPoolChoices) {
      // A real menu, not a text field with the options in its hint. The
      // instance-level option list is rebuilt per composition; the SDK's own
      // support headers expose resetOptions()/appendOption() on the instance.
      slot.kind = VariableSlot::Kind::Choice;
      slot.index = choicesUsed++;
      slot.optionValues = splitList(variable.options);
      const std::vector<std::string> labels = splitList(variable.optionLabels);
      OFX::ChoiceParam* param = poolChoices_[slot.index];
      param->setLabel(label);
      param->resetOptions();
      for (std::size_t optionIndex = 0; optionIndex < slot.optionValues.size(); ++optionIndex) {
        const bool labelled = optionIndex < labels.size() && !labels[optionIndex].empty();
        param->appendOption(labelled ? labels[optionIndex] : slot.optionValues[optionIndex]);
      }
      param->setIsSecret(false);
      param->setEnabled(true);
      if (!previouslyHeld(slot.kind, slot.index, slot.id)) {
        int defaultIndex = 0;
        for (std::size_t optionIndex = 0; optionIndex < slot.optionValues.size(); ++optionIndex) {
          if (slot.optionValues[optionIndex] == variable.defaultValue) {
            defaultIndex = static_cast<int>(optionIndex);
            break;
          }
        }
        param->setValue(defaultIndex);
      }
    } else if (textsUsed < kPoolTexts) {
      slot.kind = VariableSlot::Kind::Text;
      slot.index = textsUsed++;
      OFX::StringParam* param = poolTexts_[slot.index];
      param->setLabel(label);
      param->setIsSecret(false);
      param->setEnabled(true);
      param->setHint(variable.options.empty()
                         ? std::string("Composition variable ") + variable.id
                         : std::string("One of: ") + variable.options);
      if (!previouslyHeld(slot.kind, slot.index, slot.id)) {
        param->setValue(variable.defaultValue);
      }
    } else {
      continue;  // pool exhausted; the service keeps the declared default
    }
    mapping.push_back(std::move(slot));
  }

  for (int i = numbersUsed; i < kPoolNumbers; ++i) poolNumbers_[i]->setIsSecret(true);
  for (int i = textsUsed; i < kPoolTexts; ++i) poolTexts_[i]->setIsSecret(true);
  for (int i = coloursUsed; i < kPoolColors; ++i) poolColors_[i]->setIsSecret(true);
  // Booleans were missing from this sweep: an unused Toggle stayed visible
  // after switching to a composition declaring fewer of them.
  for (int i = booleansUsed; i < kPoolBooleans; ++i) poolBooleans_[i]->setIsSecret(true);
  for (int i = choicesUsed; i < kPoolChoices; ++i) poolChoices_[i]->setIsSecret(true);

  std::lock_guard<std::mutex> lock(variableMutex_);
  variableMap_ = std::move(mapping);
}

void NetsuFlowGenerator::syncVariables(double time) {
  const GeneratorSource source = sourceAtTime(time);
  if (source == GeneratorSource::Code && code_ != nullptr) {
    std::string code;
    code_->getValueAtTime(time, code);
    if (!code.empty()) writeSpool(code);
  }

  // A private client on a short leash: this runs on the UI thread and must not
  // block the Inspector for longer than a click feels instant-ish. It never
  // touches the render thread's connection.
  BridgeClient client;
  const BridgeStatus connectStatus = client.connect(defaultSessionDescriptorPath(), 1200);
  if (connectStatus != BridgeStatus::Ok) {
    if (status_ != nullptr) {
      status_->setValue(std::string("service unavailable: ") + client.lastError());
    }
    return;
  }

  std::vector<DescribedVariable> declared;
  std::uint32_t describedWidth = 0;
  std::uint32_t describedHeight = 0;
  std::uint32_t authoredWidth = 0;
  std::uint32_t authoredHeight = 0;
  const BridgeStatus described = client.describeComposition(
      bindingForSource(source, time), 2000, declared, &describedWidth, &describedHeight,
      &authoredWidth, &authoredHeight);
  if (described != BridgeStatus::Ok) {
    if (status_ != nullptr) status_->setValue(client.lastError());
    return;
  }

  if (describedWidth > 0 && describedHeight > 0) {
    compositionWidth_.store(describedWidth);
    compositionHeight_.store(describedHeight);
  }
  if (authoredWidth > 0 && authoredHeight > 0) {
    codeWidth_.store(authoredWidth);
    codeHeight_.store(authoredHeight);
  }

  applyVariableMapping(declared);
  if (status_ != nullptr) {
    std::string text = "connected, " + std::to_string(declared.size()) + " variable(s)";
    // The size belongs in the status line because it is the one thing that
    // silently changes what the node draws: a composition whose declared size
    // is not the timeline's is fitted, and saying so beats leaving the user to
    // infer it from a letterbox.
    if (describedWidth > 0 && describedHeight > 0) {
      text += ", " + std::to_string(describedWidth) + "x" + std::to_string(describedHeight);
    }
    // Both sizes when they disagree, because that disagreement is the whole
    // reason the Format menu offers Code as well as Composition.
    if (authoredWidth > 0 && authoredHeight > 0 &&
        (authoredWidth != describedWidth || authoredHeight != describedHeight)) {
      text += " (code " + std::to_string(authoredWidth) + "x" +
              std::to_string(authoredHeight) + ")";
    }
    status_->setValue(text);
  }
}

std::vector<protocol::VariableValue> NetsuFlowGenerator::collectVariables(double time) {
  std::vector<VariableSlot> mapping;
  {
    std::lock_guard<std::mutex> lock(variableMutex_);
    mapping = variableMap_;
  }

  std::vector<protocol::VariableValue> values;
  values.reserve(mapping.size());
  for (const VariableSlot& slot : mapping) {
    protocol::VariableValue value;
    value.id = slot.id;
    switch (slot.kind) {
      case VariableSlot::Kind::Number:
        value.value = formatNumber(poolNumbers_[slot.index]->getValueAtTime(time));
        break;
      case VariableSlot::Kind::Text:
        poolTexts_[slot.index]->getValueAtTime(time, value.value);
        break;
      case VariableSlot::Kind::Color: {
        double r = 0, g = 0, b = 0;
        poolColors_[slot.index]->getValueAtTime(time, r, g, b);
        value.value = formatColour(r, g, b);
        break;
      }
      case VariableSlot::Kind::Boolean:
        // Spelled the way JSON spells it, because the shim assigns the value
        // straight into the variable the composition reads.
        value.value = poolBooleans_[slot.index]->getValueAtTime(time) ? "true" : "false";
        break;
      case VariableSlot::Kind::Choice: {
        // The menu stores an index; the composition reads the option value.
        int optionIndex = 0;
        poolChoices_[slot.index]->getValueAtTime(time, optionIndex);
        value.value = optionIndex >= 0 &&
                      optionIndex < static_cast<int>(slot.optionValues.size())
                          ? slot.optionValues[optionIndex]
                          : "";
        break;
      }
    }
    values.push_back(std::move(value));
  }
  return values;
}

bool NetsuFlowGenerator::produceFrame(double time, std::uint32_t width, std::uint32_t height,
                                      std::uint32_t sourceFrame, std::uint32_t renderScalePpm,
                                      GeneratorSource source, const std::string& codeHash,
                                      const std::vector<protocol::VariableValue>& variables,
                                      std::vector<std::uint8_t>& frameBuffer,
                                      std::string& statusText) {
  if (!bridge_) bridge_.reset(new BridgeClient());
  BridgeClient* const bridge = bridge_.get();

  const std::string descriptorPath = defaultSessionDescriptorPath();
  const BridgeStatus connectStatus = bridge->connect(descriptorPath, 1000);
  if (connectStatus != BridgeStatus::Ok) {
    statusText = std::string("bridge: ") + bridge->lastError();
    return false;
  }

  const bool finalQuality = choiceValueAtTime(quality_, time, 0) == 1;

  FrameRequest request;
  request.binding = bindingForSource(source, time);
  // In Code and Editor modes the content hash IS the revision: the service
  // rehashes the spool on a mismatch, which is what turns "the user pasted new
  // code" into "the next frame is rendered from it" with no watcher and no
  // race. The two differ only in where the hash comes from — the Code param
  // here, the editor's Send there.
  request.sourceRevision =
      (source == GeneratorSource::Code || source == GeneratorSource::Editor) ? codeHash
                                                                            : std::string();
  request.frame = sourceFrame;
  request.width = width;
  request.height = height;
  request.renderScalePpm = renderScalePpm;
  request.quality = finalQuality ? "final" : "preview";
  request.deadlineMs = finalQuality ? 30000u : 2000u;
  request.variables = variables;

  HostAbortSignal abortSignal(*this);
  FrameResponse response;
  const BridgeStatus status = bridge->requestFrame(request, response, &abortSignal);
  if (status != BridgeStatus::Ok) {
    statusText = std::string("bridge: ") + bridge->lastError();
    return false;
  }

  const std::uint32_t bpp = protocol::bytesPerPixel(response.metadata.pixelFormat);
  if (bpp != 4) {
    statusText = "bridge: unsupported pixel format for the current copy path";
    return false;
  }
  const std::size_t rowBytes = static_cast<std::size_t>(width) * bpp;
  frameBuffer.resize(rowBytes * height);
  for (std::uint32_t y = 0; y < height; ++y) {
    const std::size_t sourceOffset = static_cast<std::size_t>(y) * response.metadata.stride;
    if (sourceOffset + rowBytes > response.pixels.size()) {
      statusText = "bridge: response shorter than its declared stride";
      return false;
    }
    std::memcpy(frameBuffer.data() + static_cast<std::size_t>(y) * rowBytes,
                response.pixels.data() + sourceOffset, rowBytes);
  }
  statusText = "bridge";
  return true;
}

void NetsuFlowGenerator::render(const OFX::RenderArguments& args) {
  log::Line entry("render");
  entry.add("instance", instanceId_)
      .add("time", args.time)
      .add("scaleX", args.renderScale.x)
      .add("scaleY", args.renderScale.y)
      .add("winX1", static_cast<std::int64_t>(args.renderWindow.x1))
      .add("winY1", static_cast<std::int64_t>(args.renderWindow.y1))
      .add("winX2", static_cast<std::int64_t>(args.renderWindow.x2))
      .add("winY2", static_cast<std::int64_t>(args.renderWindow.y2))
      .add("interactive", args.interactiveRenderStatus);

  if (reloadRequested_.exchange(false, std::memory_order_acquire)) {
    lastPixels_.clear();
    lastPixels_.shrink_to_fit();
    lastValid_ = false;
    lastKey_ = FrameKey{};
    if (bridge_) {
      bridge_->close();
      bridge_->resetConnectBackoff();
    }
    entry.add("reloaded", true);
  }

  if (dstClip_ == nullptr) {
    entry.add("result", std::string("no output clip")).commit();
    OFX::throwSuiteStatusException(kOfxStatFailed);
    return;
  }

  std::unique_ptr<OFX::Image> dst(dstClip_->fetchImage(args.time));
  if (!dst) {
    entry.add("result", std::string("no output image")).commit();
    OFX::throwSuiteStatusException(kOfxStatFailed);
    return;
  }

  const OFX::BitDepthEnum depth = dst->getPixelDepth();
  const OFX::PixelComponentEnum components = dst->getPixelComponents();
  entry.add("depth", static_cast<std::int64_t>(depth))
      .add("components", static_cast<std::int64_t>(components));

  if (components != OFX::ePixelComponentRGBA ||
      (depth != OFX::eBitDepthUByte && depth != OFX::eBitDepthFloat)) {
    entry.add("result", std::string("unsupported output format")).commit();
    OFX::throwSuiteStatusException(kOfxStatErrUnsupported);
    return;
  }

  const OfxRectI bounds = dst->getBounds();
  const std::int64_t imageWidth = static_cast<std::int64_t>(bounds.x2) - bounds.x1;
  const std::int64_t imageHeight = static_cast<std::int64_t>(bounds.y2) - bounds.y1;
  entry.add("imageW", imageWidth).add("imageH", imageHeight);

  if (imageWidth <= 0 || imageHeight <= 0 ||
      imageWidth > static_cast<std::int64_t>(kMaxFrameDimension) ||
      imageHeight > static_cast<std::int64_t>(kMaxFrameDimension)) {
    entry.add("result", std::string("image bounds out of range")).commit();
    OFX::throwSuiteStatusException(kOfxStatErrValue);
    return;
  }

  const std::uint32_t width = static_cast<std::uint32_t>(imageWidth);
  const std::uint32_t height = static_cast<std::uint32_t>(imageHeight);
  const std::uint32_t sourceFrame = resolveSourceFrame(args.time);
  const double scale = args.renderScale.x > 0.0 ? args.renderScale.x : 1.0;
  const std::uint32_t renderScalePpm =
      static_cast<std::uint32_t>(std::lround((std::min)(scale, 4.0) * 1000000.0));
  entry.add("sourceFrame", static_cast<std::int64_t>(sourceFrame));

  const GeneratorSource source = sourceAtTime(args.time);

  std::string codeHash;
  if (source == GeneratorSource::Code) {
    codeHash = codeHashForRender(args.time);
  } else if (source == GeneratorSource::Editor) {
    // Sixteen bytes off disk per frame, and it has to be per frame: the point
    // of this mode is that pressing Send in the browser changes the node's
    // picture without anyone touching Resolve. Nothing is written back — the
    // editor owns the spool here.
    codeHash = readEditorRevision();
  }

  std::uint32_t frameWidth = width;
  std::uint32_t frameHeight = height;
  requestedSize(args.time, width, height, frameWidth, frameHeight);

  const std::vector<protocol::VariableValue> variables = collectVariables(args.time);
  std::string variablesPacked;
  for (const protocol::VariableValue& value : variables) {
    variablesPacked += value.id;
    variablesPacked += '\x1F';
    variablesPacked += value.value;
    variablesPacked += '\x1E';
  }

  // The key describes the frame the service produces, not the frame the host
  // asked for: fit is applied after, so changing it must not throw the pixels
  // away and re-render them identically.
  FrameKey key;
  key.frame = sourceFrame;
  key.width = frameWidth;
  key.height = frameHeight;
  key.renderScalePpm = renderScalePpm;
  key.source = static_cast<int>(source);
  key.quality = choiceValueAtTime(quality_, args.time, 0);
  key.binding = bindingForSource(source, args.time);
  key.revision = codeHash;
  key.variables = variablesPacked;

  std::vector<std::uint8_t> frameBuffer;
  std::string statusText;
  bool produced = false;

  if (lastValid_ && lastKey_ == key) {
    frameBuffer = lastPixels_;
    statusText = "cached";
    produced = true;
    entry.add("cacheHit", true);
  } else {
    if (source == GeneratorSource::Code && codeHash.empty()) {
      statusText = "paste composition HTML into Code";
      produced = false;
    } else if (source == GeneratorSource::Editor && codeHash.empty()) {
      statusText = "open the editor and press Send";
      produced = false;
    } else {
      try {
        produced = produceFrame(args.time, frameWidth, frameHeight, sourceFrame, renderScalePpm,
                                source, codeHash, variables, frameBuffer, statusText);
      } catch (const std::exception& error) {
        statusText = std::string("internal error: ") + error.what();
        produced = false;
      } catch (...) {
        statusText = "internal error";
        produced = false;
      }
    }
    entry.add("cacheHit", false);
  }

  if (!produced) {
    const bool reuseLastGood = args.interactiveRenderStatus && lastValid_ &&
                               lastKey_.width == frameWidth && lastKey_.height == frameHeight &&
                               !lastPixels_.empty();
    if (reuseLastGood) {
      frameBuffer = lastPixels_;
      statusText += " (last good frame)";
    } else {
      // The error frame is produced at the host's size and drawn without a fit,
      // because a letterboxed error frame reads as a composition that rendered.
      frameWidth = width;
      frameHeight = height;
      fillSolid(frameBuffer, static_cast<std::size_t>(width) * height, kErrorColour);
    }
    entry.add("fallback", reuseLastGood ? std::string("lastGood") : std::string("errorFrame"));
  } else if (frameBuffer.size() <= kMaxRetainedBytes) {
    lastPixels_ = frameBuffer;
    lastKey_ = key;
    lastValid_ = true;
  }
  entry.add("status", statusText);

  const int x1 = (std::max)(args.renderWindow.x1, bounds.x1);
  const int y1 = (std::max)(args.renderWindow.y1, bounds.y1);
  const int x2 = (std::min)(args.renderWindow.x2, bounds.x2);
  const int y2 = (std::min)(args.renderWindow.y2, bounds.y2);

  const FitTransform fit = computeFit(
      static_cast<FitMode>(choiceValueAtTime(fit_, args.time, 0)),
      frameWidth, frameHeight, width, height);
  const std::uint8_t* const pixels = frameBuffer.data();
  static const std::uint8_t kTransparent[4] = {0, 0, 0, 0};

  bool observedAbort = false;
  for (int y = y1; y < y2; ++y) {
    if (abort()) {
      observedAbort = true;
      break;
    }
    // OpenFX images are bottom-up; the service buffer is top-down.
    const std::uint32_t destinationRow = static_cast<std::uint32_t>(bounds.y2 - 1 - y);
    if (destinationRow >= height) continue;

    std::uint8_t* byteRow = nullptr;
    float* floatRow = nullptr;
    if (depth == OFX::eBitDepthUByte) {
      byteRow = static_cast<std::uint8_t*>(dst->getPixelAddress(x1, y));
      if (byteRow == nullptr) continue;
    } else {
      floatRow = static_cast<float*>(dst->getPixelAddress(x1, y));
      if (floatRow == nullptr) continue;
    }

    // Sample position along the source row, in pixel centres. Precomputed per
    // row because only the column varies inside the loop.
    const double sourceY = fit.scaleY > 0.0
        ? ((destinationRow + 0.5) - fit.offsetY) / fit.scaleY - 0.5
        : -1.0;
    const bool rowInside = sourceY > -0.5 && sourceY < static_cast<double>(frameHeight) - 0.5;

    for (int x = x1; x < x2; ++x) {
      const std::size_t destinationColumn = static_cast<std::size_t>(x - bounds.x1);
      if (destinationColumn >= width) break;

      const std::uint8_t* px = kTransparent;
      std::uint8_t sampled[4];
      if (fit.identity) {
        // Unscaled: index straight into the buffer, no resampler, no rounding.
        if (destinationColumn < frameWidth && destinationRow < frameHeight) {
          px = pixels + ((static_cast<std::size_t>(destinationRow) * frameWidth) +
                         destinationColumn) * 4u;
        }
      } else if (rowInside) {
        const double sourceX = fit.scaleX > 0.0
            ? ((destinationColumn + 0.5) - fit.offsetX) / fit.scaleX - 0.5
            : -1.0;
        if (sourceX > -0.5 && sourceX < static_cast<double>(frameWidth) - 0.5) {
          sampleBilinear(pixels, frameWidth, frameHeight, sourceX, sourceY, sampled);
          px = sampled;
        }
      }

      // The service delivers straight alpha; the host composites premultiplied.
      // Multiplying here is the entire fix for H04's soft-edge defect: a glow at
      // 2% alpha keeps 2% of its colour instead of arriving at full strength.
      if (byteRow != nullptr) {
        const std::uint32_t a = px[3];
        byteRow[0] = static_cast<std::uint8_t>((px[0] * a + 127u) / 255u);
        byteRow[1] = static_cast<std::uint8_t>((px[1] * a + 127u) / 255u);
        byteRow[2] = static_cast<std::uint8_t>((px[2] * a + 127u) / 255u);
        byteRow[3] = px[3];
        byteRow += 4;
      } else {
        const float a = static_cast<float>(px[3]) / 255.0f;
        floatRow[0] = (static_cast<float>(px[0]) / 255.0f) * a;
        floatRow[1] = (static_cast<float>(px[1]) / 255.0f) * a;
        floatRow[2] = (static_cast<float>(px[2]) / 255.0f) * a;
        floatRow[3] = a;
        floatRow += 4;
      }
    }
  }

  entry.add("abortObserved", observedAbort).add("result", std::string("done")).commit();
}

void NetsuFlowGenerator::getClipPreferences(OFX::ClipPreferencesSetter& clipPreferences) {
  clipPreferences.setOutputFrameVarying(true);
}

void NetsuFlowGenerator::updateSourceVisibility(double time) {
  const GeneratorSource source = sourceAtTime(time);
  if (code_ != nullptr) code_->setIsSecret(source != GeneratorSource::Code);
  if (binding_ != nullptr) binding_->setIsSecret(source != GeneratorSource::NetsuRush);
}

void NetsuFlowGenerator::changedParam(const OFX::InstanceChangedArgs& args,
                                      const std::string& name) {
  // All of this runs on the UI thread. Parameter property writes belong here
  // and never on a render thread; render() consumes the reload flag on its own
  // thread so the bridge socket is never closed from under it.

  // The Code cache is only ever invalidated here, because this is the only
  // place the param can change. Source matters too: leaving Code and coming
  // back must re-spool, since another mode may have rewritten the file.
  if (name == kParamCode || name == kParamSource || name == kParamReload) {
    std::lock_guard<std::mutex> lock(codeMutex_);
    codeDirty_ = true;
  }

  if (name == kParamFormat) {
    // Custom size fields are noise in every other mode.
    const bool custom =
        static_cast<FormatSource>(choiceValueAtTime(format_, args.time, 0)) == FormatSource::Custom;
    if (customSize_ != nullptr) customSize_->setIsSecret(!custom);
    return;
  }

  if (name == kParamSource) {
    updateSourceVisibility(args.time);
    reloadRequested_.store(true, std::memory_order_release);
    syncVariables(args.time);
    log::Line("sourceChanged").add("instance", instanceId_).commit();
    return;
  }

  if (name == kParamCode || name == kParamBinding) {
    reloadRequested_.store(true, std::memory_order_release);
    syncVariables(args.time);
    return;
  }

  if (name == kParamReload) {
    reloadRequested_.store(true, std::memory_order_release);
    syncVariables(args.time);
    log::Line("reload").add("instance", instanceId_).commit();
    return;
  }

  if (name == kParamOpenEditor) {
    // The editor is a page served by the same service, on the same loopback
    // port the session descriptor already names. Spooling first means it opens
    // showing whatever is currently in Code, not the last thing rendered.
    if (code_ != nullptr) {
      std::string code;
      code_->getValueAtTime(args.time, code);
      if (!code.empty()) writeSpool(code);
    }
    SessionDescriptor descriptor;
    if (loadSessionDescriptor(defaultSessionDescriptorPath(), descriptor) != SessionStatus::Ok) {
      if (status_ != nullptr) status_->setValue("editor unavailable: service not running");
      return;
    }
    if (descriptor.editorPort == 0) {
      if (status_ != nullptr) {
        status_->setValue("this service was started without the editor");
      }
      return;
    }
    openEditor(descriptor.editorPort);
    if (status_ != nullptr) {
      status_->setValue("editor opened on 127.0.0.1:" + std::to_string(descriptor.editorPort));
    }
    log::Line("openEditor").add("instance", instanceId_).commit();
    return;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

NetsuFlowGeneratorFactory::NetsuFlowGeneratorFactory()
    : OFX::PluginFactoryHelper<NetsuFlowGeneratorFactory>(kPluginIdentifier, kPluginVersionMajor,
                                                          kPluginVersionMinor) {}

void NetsuFlowGeneratorFactory::describe(OFX::ImageEffectDescriptor& desc) {
  desc.setLabels(kPluginName, kPluginName, kPluginName);
  desc.setPluginGrouping(kPluginGrouping);
  desc.setPluginDescription(kPluginDescription);

  desc.addSupportedContext(OFX::eContextGenerator);
  desc.addSupportedBitDepth(OFX::eBitDepthUByte);
  desc.addSupportedBitDepth(OFX::eBitDepthFloat);

  desc.setSingleInstance(false);
  desc.setHostFrameThreading(false);
  desc.setSupportsMultiResolution(kSupportsMultiResolution);
  desc.setSupportsTiles(kSupportsTiles);
  desc.setTemporalClipAccess(false);
  desc.setRenderTwiceAlways(false);
  desc.setSupportsMultipleClipPARs(false);
  desc.setRenderThreadSafety(OFX::eRenderInstanceSafe);
}

void NetsuFlowGeneratorFactory::describeInContext(OFX::ImageEffectDescriptor& desc,
                                                  OFX::ContextEnum /*context*/) {
  OFX::ClipDescriptor* dstClip = desc.defineClip(kOfxImageEffectOutputClipName);
  dstClip->addSupportedComponent(OFX::ePixelComponentRGBA);
  dstClip->setSupportsTiles(kSupportsTiles);

  OFX::PageParamDescriptor* page = desc.definePageParam("Controls");

  // Everything the user reads goes through tr(); everything the project saves
  // (parameter names, option order) is locale-independent.
  const auto labels = [](auto* param, const char* english, const char* french) {
    const char* text = tr(english, french);
    param->setLabels(text, text, text);
  };

  OFX::ChoiceParamDescriptor* source = desc.defineChoiceParam(kParamSource);
  labels(source, "Source", "Source");
  source->setHint(tr("Where the composition comes from.", "D'où vient la composition."));
  source->appendOption("Code", tr("The HTML pasted into the Code field below",
                                  "Le HTML collé dans le champ Code ci-dessous"));
  source->appendOption("Editor", tr("Whatever the browser editor last sent with its Send button",
                                    "Ce que l'éditeur navigateur a envoyé en dernier"));
  source->appendOption("NetsuRush", tr("A composition managed by the NetsuRush app",
                                       "Une composition gérée par l'application NetsuRush"));
  source->setDefault(0);
  page->addChild(*source);

  OFX::StringParamDescriptor* code = desc.defineStringParam(kParamCode);
  labels(code, "Code", "Code");
  code->setHint(tr(
      "Composition HTML. Paste a catalog component or your own page; its declared variables "
      "appear below after Reload.",
      "HTML de la composition. Colle un composant du catalogue ou ta propre page ; "
      "ses variables apparaissent plus bas après Recharger."));
  code->setStringType(OFX::eStringTypeMultiLine);
  code->setDefault("");
  page->addChild(*code);

  OFX::StringParamDescriptor* binding = desc.defineStringParam(kParamBinding);
  labels(binding, "Binding", "Binding");
  binding->setHint(tr("NetsuRush-managed composition identifier.",
                      "Identifiant d'une composition gérée par NetsuRush."));
  binding->setStringType(OFX::eStringTypeSingleLine);
  binding->setDefault("netsurush");
  binding->setIsSecret(true);  // visible only when Source is NetsuRush
  page->addChild(*binding);

  OFX::IntParamDescriptor* startFrame = desc.defineIntParam(kParamStartFrame);
  labels(startFrame, "Start Frame", "Image de départ");
  startFrame->setHint(tr("Host frame that maps to composition frame 0.",
                         "Image de l'hôte correspondant à l'image 0 de la composition."));
  startFrame->setDefault(0);
  startFrame->setRange(-1000000, 1000000);
  startFrame->setDisplayRange(-1000, 1000);
  page->addChild(*startFrame);

  OFX::ChoiceParamDescriptor* quality = desc.defineChoiceParam(kParamQuality);
  labels(quality, "Quality", "Qualité");
  quality->appendOption(tr("Preview", "Aperçu"),
                        tr("Short deadline, may fall back to the last good frame",
                           "Délai court, peut resservir la dernière image valide"));
  quality->appendOption("Final", tr("Long deadline, never substitutes a stale frame",
                                    "Délai long, jamais d'image périmée"));
  quality->setDefault(0);
  page->addChild(*quality);

  // ---- Format ---------------------------------------------------------------
  // A composition is authored at its own resolution and may lay out entirely
  // differently at another, so the size it is rendered at is a real decision
  // rather than a consequence of which timeline the node happens to sit in.
  OFX::ChoiceParamDescriptor* format = desc.defineChoiceParam(kParamFormat);
  labels(format, "Format", "Format");
  format->setHint(tr("The resolution the composition is laid out at, before it is fitted.",
                     "La résolution de mise en page de la composition, avant ajustement."));
  format->appendOption("Code", tr("The size the pasted code declares for itself",
                                  "La taille que le code collé déclare"));
  format->appendOption("Composition", tr("Whatever the service is currently rendering at",
                                         "Ce que le service rend actuellement"));
  format->appendOption(tr("Custom", "Personnalisé"),
                       tr("A size you choose; the composition re-lays out at it",
                          "Une taille choisie ; la composition se remet en page"));
  format->setDefault(0);
  page->addChild(*format);

  OFX::Int2DParamDescriptor* customSize = desc.defineInt2DParam(kParamCustomSize);
  labels(customSize, "Size", "Taille");
  customSize->setHint(tr("Width and height to lay the composition out at.",
                         "Largeur et hauteur de mise en page."));
  customSize->setDefault(1920, 1080);
  customSize->setRange(16, 16, 16384, 16384);
  customSize->setDisplayRange(16, 16, 3840, 3840);
  customSize->setIsSecret(true);  // visible only when Format is Custom
  page->addChild(*customSize);

  OFX::ChoiceParamDescriptor* fit = desc.defineChoiceParam(kParamFit);
  labels(fit, "Fit", "Fit");
  fit->setHint(tr("How the composition is placed into the frame the host asked for.",
                  "Comment la composition est placée dans l'image demandée par l'hôte."));
  fit->appendOption("Contain", tr("Whole composition visible, transparent where it does not reach",
                                  "Tout visible, transparent là où elle ne va pas"));
  fit->appendOption("Cover", tr("Fills the frame; whatever falls outside is cropped",
                                "Remplit l'image ; ce qui dépasse est rogné"));
  fit->appendOption("Stretch", tr("Fills the frame exactly, ignoring the aspect ratio",
                                  "Remplit exactement, sans respecter le ratio"));
  fit->appendOption(tr("Actual size", "Taille réelle"),
                    tr("No scaling; centred, and cropped if larger",
                       "Aucune mise à l'échelle ; centrée, rognée si plus grande"));
  fit->setDefault(0);
  page->addChild(*fit);

  // ---- Composition variables ------------------------------------------------
  // A fixed pool of generic controls, hidden until a DESCRIBE names them.
  // OpenFX parameters cannot be created at runtime; this is the only shape
  // per-composition controls can take. 8/16/4/4/4 covers every catalog
  // component inspected so far, the 22-variable paste included.
  OFX::GroupParamDescriptor* group = desc.defineGroupParam(kGroupComposition);
  group->setLabels("Composition", "Composition", "Composition");
  group->setOpen(true);

  for (int i = 0; i < kPoolNumbers; ++i) {
    OFX::DoubleParamDescriptor* param =
        desc.defineDoubleParam(("nfNum" + std::to_string(i)).c_str());
    labels(param, "Number", "Nombre");
    param->setDefault(0.0);
    param->setRange(-1000000.0, 1000000.0);
    param->setDisplayRange(0.0, 100.0);
    param->setIsSecret(true);
    param->setParent(*group);
    page->addChild(*param);
  }
  for (int i = 0; i < kPoolTexts; ++i) {
    OFX::StringParamDescriptor* param =
        desc.defineStringParam(("nfText" + std::to_string(i)).c_str());
    labels(param, "Text", "Texte");
    param->setStringType(OFX::eStringTypeSingleLine);
    param->setDefault("");
    param->setIsSecret(true);
    param->setParent(*group);
    page->addChild(*param);
  }
  for (int i = 0; i < kPoolBooleans; ++i) {
    OFX::BooleanParamDescriptor* param =
        desc.defineBooleanParam(("nfBool" + std::to_string(i)).c_str());
    labels(param, "Toggle", "Interrupteur");
    param->setDefault(false);
    param->setIsSecret(true);
    param->setParent(*group);
    page->addChild(*param);
  }
  for (int i = 0; i < kPoolColors; ++i) {
    OFX::RGBParamDescriptor* param = desc.defineRGBParam(("nfColor" + std::to_string(i)).c_str());
    labels(param, "Color", "Couleur");
    param->setDefault(1.0, 1.0, 1.0);
    param->setIsSecret(true);
    param->setParent(*group);
    page->addChild(*param);
  }
  for (int i = 0; i < kPoolChoices; ++i) {
    OFX::ChoiceParamDescriptor* param =
        desc.defineChoiceParam(("nfChoice" + std::to_string(i)).c_str());
    labels(param, "List", "Liste");
    // One placeholder option so the descriptor is well-formed; the real
    // options are installed on the instance when a DESCRIBE names this slot.
    param->appendOption("-");
    param->setDefault(0);
    param->setIsSecret(true);
    param->setParent(*group);
    page->addChild(*param);
  }

  OFX::PushButtonParamDescriptor* openEditor = desc.definePushButtonParam(kParamOpenEditor);
  labels(openEditor, "Open Editor", "Ouvrir l'éditeur");
  openEditor->setHint(tr(
      "Opens the composition editor in a browser: paste, see the render, scrub, and adjust "
      "parameters. Saving there updates this node.",
      "Ouvre l'éditeur de composition dans un navigateur : colle, vois le rendu, ajuste. "
      "Envoyer là-bas met ce nœud à jour."));
  page->addChild(*openEditor);

  OFX::PushButtonParamDescriptor* reload = desc.definePushButtonParam(kParamReload);
  labels(reload, "Reload", "Recharger");
  reload->setHint(tr("Reconnect, re-read the composition, and refresh the variables below.",
                     "Reconnecte, relit la composition, rafraîchit les variables ci-dessous."));
  page->addChild(*reload);

  OFX::StringParamDescriptor* status = desc.defineStringParam(kParamStatus);
  labels(status, "Status", "État");
  status->setStringType(OFX::eStringTypeSingleLine);
  status->setDefault("not connected");
  status->setEnabled(false);
  status->setEvaluateOnChange(false);
  page->addChild(*status);
}

OFX::ImageEffect* NetsuFlowGeneratorFactory::createInstance(OfxImageEffectHandle handle,
                                                            OFX::ContextEnum /*context*/) {
  return new NetsuFlowGenerator(handle);
}

}  // namespace netsuflow
