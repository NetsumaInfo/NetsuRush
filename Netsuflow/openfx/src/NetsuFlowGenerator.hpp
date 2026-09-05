// NetsuFlow OpenFX Generator.
//
// Two ways to feed it, one node: paste a composition's HTML into the Code
// field, or hand control to NetsuRush through an opaque binding. Either way the
// pixels come from the out-of-process renderer service; the plugin never
// launches a browser and never executes user JavaScript in-process.
//
// The variables a composition declares (data-composition-variables) surface at
// the bottom of the Inspector through a fixed pool of generic controls that are
// relabelled and revealed after a DESCRIBE round-trip. OpenFX parameters cannot
// be created after describeInContext, so a pre-declared pool is the only shape
// dynamic controls can take.
#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "ofxsImageEffect.h"

#include "BridgeClient.hpp"

namespace netsuflow {

/// Value of the "Source" choice parameter.
///
/// Option order is the saved-project contract: Resolve stores the index, not
/// the label. This order changed once, at v0.2, when the Diagnostic pattern
/// left the menu — it was a bring-up aid with no use once real compositions
/// rendered, and it sat between the two sources anyone actually picks. Code
/// stayed at 0, so the only projects affected are ones that had chosen
/// Diagnostic or NetsuRush explicitly.
/// How a composition of one size is placed into the frame the host asked for.
enum class FitMode {
  Contain = 0,  ///< whole composition visible, transparent bars where it does not reach
  Cover = 1,    ///< fills the frame, whatever falls outside is cropped
  Stretch = 2,  ///< fills the frame exactly, ignoring the aspect ratio
  Actual = 3,   ///< no scaling; centred, and cropped if larger
};

/// Where the size to render at comes from.
enum class FormatSource {
  Code = 0,         ///< the size the pasted code declares for itself
  Composition = 1,  ///< whatever the service is currently bound to
  Custom = 2,       ///< an explicit width and height
};

enum class GeneratorSource {
  Code = 0,       ///< the Code field, spooled to disk for the service
  Editor = 1,     ///< whatever the browser editor last sent
  NetsuRush = 2,  ///< an app-managed binding
};

/// How many of each generic control the pool declares. Raising these means a
/// new plugin build; compositions declaring more variables than fit simply have
/// the overflow left at their declared defaults service-side.
inline constexpr int kPoolNumbers = 8;
inline constexpr int kPoolTexts = 16;
inline constexpr int kPoolColors = 4;
inline constexpr int kPoolBooleans = 4;
inline constexpr int kPoolChoices = 4;

class NetsuFlowGenerator : public OFX::ImageEffect {
 public:
  explicit NetsuFlowGenerator(OfxImageEffectHandle handle);
  ~NetsuFlowGenerator() override;

  void render(const OFX::RenderArguments& args) override;
  void changedParam(const OFX::InstanceChangedArgs& args, const std::string& name) override;

  /// Declares that this generator produces a different image on every frame.
  ///
  /// Without it the property defaults to false, and a host is entitled to
  /// render one frame and reuse it for the whole clip — which is exactly what
  /// Resolve does. Measured: the service was answering distinct frames in
  /// 14 ms while the viewer showed one still, because the host never asked
  /// again. A generator with no input clip has nothing else to tell the host
  /// that its output moves.
  void getClipPreferences(OFX::ClipPreferencesSetter& clipPreferences) override;

 private:
  /// One pool control currently standing in for a declared variable.
  struct VariableSlot {
    std::string id;
    enum class Kind { Number, Text, Color, Boolean, Choice } kind = Kind::Text;
    int index = 0;
    /// For Choice slots: the declared option values, in menu order. The menu
    /// stores an index; this is how the index becomes the string the
    /// composition actually reads.
    std::vector<std::string> optionValues;
  };

  bool produceFrame(double time, std::uint32_t width, std::uint32_t height,
                    std::uint32_t sourceFrame, std::uint32_t renderScalePpm,
                    GeneratorSource source, const std::string& codeHash,
                    const std::vector<protocol::VariableValue>& variables,
                    std::vector<std::uint8_t>& frameBuffer, std::string& statusText);

  std::uint32_t resolveSourceFrame(double time) const;
  GeneratorSource sourceAtTime(double time) const;
  std::string bindingForSource(GeneratorSource source, double time) const;

  /// The size to ask the service for. Not the host's frame size: a composition
  /// is authored at its own resolution, and laying a 1080x1920 portrait piece
  /// out in a 1920x1080 viewport does not letterbox it — it lays out wrong and
  /// arrives cropped, which is the defect this replaces.
  void requestedSize(double time, std::uint32_t hostWidth, std::uint32_t hostHeight,
                     std::uint32_t& outWidth, std::uint32_t& outHeight) const;

  /// Reads the Code param at most once per edit, spooling it when it changed.
  std::string codeHashForRender(double time);

  /// Writes the Code field to the spool file the service watches, returning the
  /// content hash. Safe from either thread: file writes are atomic-rename and
  /// the hash is what render() keys on, not the write itself.
  std::string writeSpool(const std::string& code);

  /// UI-thread only. Connects on a short deadline, asks the service what the
  /// current composition declares, and maps the declarations onto the pool.
  void syncVariables(double time);
  void applyVariableMapping(const std::vector<DescribedVariable>& declared);
  void updateSourceVisibility(double time);

  /// Reads the pool values for the current mapping. Called on the render
  /// thread; the mapping is copied under the mutex, values are read from the
  /// params directly (value reads are render-thread legal).
  std::vector<protocol::VariableValue> collectVariables(double time);

  OFX::Clip* dstClip_ = nullptr;

  OFX::ChoiceParam* source_ = nullptr;
  OFX::StringParam* code_ = nullptr;
  OFX::StringParam* binding_ = nullptr;
  OFX::StringParam* status_ = nullptr;
  OFX::IntParam* startFrame_ = nullptr;
  OFX::ChoiceParam* quality_ = nullptr;
  OFX::ChoiceParam* format_ = nullptr;
  OFX::Int2DParam* customSize_ = nullptr;
  OFX::ChoiceParam* fit_ = nullptr;

  /// Two sizes, because they are not the same question and confusing them is
  /// what made a portrait composition arrive cropped. The composition size is
  /// whatever the service is bound to right now, which the editor can override;
  /// the code size is what the pasted HTML declares for itself, whatever anyone
  /// has since overridden. Zero until a DESCRIBE has answered.
  std::atomic<std::uint32_t> compositionWidth_{0};
  std::atomic<std::uint32_t> compositionHeight_{0};
  std::atomic<std::uint32_t> codeWidth_{0};
  std::atomic<std::uint32_t> codeHeight_{0};

  /// Cached Code param, because reading it is not cheap. The field holds a
  /// whole composition — 51 KB for a real one — and render() was fetching and
  /// hashing all of it on every frame, on the render thread, 24 times a second.
  /// The param can only change through changedParam, so that is where the flag
  /// is raised.
  std::mutex codeMutex_;
  std::string codeHashCache_;
  bool codeDirty_ = true;

  OFX::DoubleParam* poolNumbers_[kPoolNumbers] = {};
  OFX::StringParam* poolTexts_[kPoolTexts] = {};
  OFX::RGBParam* poolColors_[kPoolColors] = {};
  OFX::BooleanParam* poolBooleans_[kPoolBooleans] = {};
  OFX::ChoiceParam* poolChoices_[kPoolChoices] = {};

  std::mutex variableMutex_;
  std::vector<VariableSlot> variableMap_;

  /// Content hash of the last spool write, so render() can detect a reopened
  /// project whose Code param no longer matches the file on disk and heal it.
  std::mutex spoolMutex_;
  std::string spooledHash_;

  std::atomic<bool> reloadRequested_{false};

  std::unique_ptr<BridgeClient> bridge_;
  std::string instanceId_;

  /// Everything that changes which pixels a render should produce.
  struct FrameKey {
    std::uint32_t frame = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t renderScalePpm = 0;
    int source = -1;
    int quality = -1;
    std::string binding;
    std::string revision;
    std::string variables;

    bool operator==(const FrameKey& other) const {
      return frame == other.frame && width == other.width && height == other.height &&
             renderScalePpm == other.renderScalePpm && source == other.source &&
             quality == other.quality && binding == other.binding &&
             revision == other.revision && variables == other.variables;
    }
  };

  /// Single-frame cache. Measured in T01: Resolve asked this node for the same
  /// frame 21 times in one session, twice within 23 ms. It also doubles as the
  /// last-good frame for the interactive failure path.
  FrameKey lastKey_;
  std::vector<std::uint8_t> lastPixels_;
  bool lastValid_ = false;

  static constexpr std::size_t kMaxRetainedBytes = 3840u * 2160u * 4u;
};

class NetsuFlowGeneratorFactory : public OFX::PluginFactoryHelper<NetsuFlowGeneratorFactory> {
 public:
  NetsuFlowGeneratorFactory();

  void describe(OFX::ImageEffectDescriptor& desc) override;
  void describeInContext(OFX::ImageEffectDescriptor& desc, OFX::ContextEnum context) override;
  OFX::ImageEffect* createInstance(OfxImageEffectHandle handle, OFX::ContextEnum context) override;
};

}  // namespace netsuflow
