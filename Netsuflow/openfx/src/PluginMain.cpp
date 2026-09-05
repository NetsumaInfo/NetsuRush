#include "ofxsImageEffect.h"

#include "NetsuFlowGenerator.hpp"

void OFX::Plugin::getPluginIDs(OFX::PluginFactoryArray& factories) {
  static netsuflow::NetsuFlowGeneratorFactory generator;
  factories.push_back(&generator);
}
