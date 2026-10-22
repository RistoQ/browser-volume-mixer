/*
 * Firefox Volume Mixer - shared constants and pure helpers.
 *
 * Loaded in the background page, the popup and the isolated-world content
 * script. It must never call a browser.* API at load time, and it must be
 * safe to load more than once (the guard below makes it idempotent).
 */
(function (root) {
  'use strict';

  if (root.VM) {
    return;
  }

  /* Gain is a linear multiplier: 1 = 100 %, 2 = 200 %. */
  var MIN_GAIN = 0;
  var MAX_GAIN = 2;
  var DEFAULT_GAIN = 1;

  var MSG = {
    /* content script (bridge) -> background */
    HELLO: 'vm:hello',
    REPORT: 'vm:report',
    /* background -> content script (bridge) */
    APPLY: 'vm:apply',
    PING: 'vm:ping',
    /* popup <-> background (over a port) */
    GET_STATE: 'vm:get-state',
    STATE: 'vm:state',
    SET_TAB_GAIN: 'vm:set-tab-gain',
    SET_MASTER: 'vm:set-master',
    SET_MUTED: 'vm:set-muted',
    RESET: 'vm:reset'
  };

  var STORAGE_MASTER = 'vm_master';
  var STORAGE_SITES = 'vm_sites';
  var PORT_NAME = 'vm-popup';

  function clampGain(value) {
    var n = Number(value);
    if (!isFinite(n)) {
      return DEFAULT_GAIN;
    }
    if (n < MIN_GAIN) {
      return MIN_GAIN;
    }
    if (n > MAX_GAIN) {
      return MAX_GAIN;
    }
    return n;
  }

  function toPercent(gain) {
    return Math.round(clampGain(gain) * 100);
  }

  root.VM = {
    MIN_GAIN: MIN_GAIN,
    MAX_GAIN: MAX_GAIN,
    DEFAULT_GAIN: DEFAULT_GAIN,
    MSG: MSG,
    STORAGE_MASTER: STORAGE_MASTER,
    STORAGE_SITES: STORAGE_SITES,
    PORT_NAME: PORT_NAME,
    clampGain: clampGain,
    toPercent: toPercent
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
