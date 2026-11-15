/**
 * Per-feature on/off switch (v1.2.4-multi). Backed by the same live-cached
 * admin_config store as every other Global Config knob: a feature is ON
 * unless an admin has stored `feature_<key> = off`. Lets an operator ship or
 * pull one area (say Actions) without a redeploy.
 */
const globalConfig = require('./globalConfig');

const KEY_RE = /^[a-z][a-z_]{1,29}$/;

function configKey(feature) {
  if (!KEY_RE.test(String(feature))) throw new Error(`Invalid feature key: ${feature}`);
  return `feature_${feature}`;
}

function isEnabled(feature) {
  return globalConfig.get(configKey(feature)) !== 'off';
}

module.exports = { isEnabled, configKey, KEY_RE };
