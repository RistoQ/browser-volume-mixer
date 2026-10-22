/*
 * Firefox Volume Mixer - content script bridge (isolated world).
 *
 * The isolated world is where extension APIs live (browser.runtime,
 * browser.storage), while the page-world hook (content/media-hook.js) is
 * where the page's audio objects live. This file is the only thing that
 * talks to both, using window.postMessage.
 *
 *   background -> bridge : { type: 'vm:apply', tabGain } | { type: 'vm:ping' }
 *   bridge -> background : { type: 'vm:hello' } | { type: 'vm:report', ... }
 */
(function () {
  'use strict';

  var MSG = VM.MSG;
  var STORAGE_MASTER = VM.STORAGE_MASTER;
  var DEFAULT_GAIN = VM.DEFAULT_GAIN;
  var clampGain = VM.clampGain;

  var tabGain = DEFAULT_GAIN;
  var master = DEFAULT_GAIN;
  var report = { active: 0, limited: 0, media: 0 };
  var extensionAlive = true;

  function effectiveGain() {
    return clampGain(tabGain * master);
  }

  function pushGain() {
    if (!extensionAlive) {
      return;
    }
    try {
      window.postMessage({ __vmHook: true, type: 'set', gain: effectiveGain() }, '*');
    } catch (e) {
      /* the page is going away */
    }
  }

  function sendReport() {
    if (!extensionAlive) {
      return;
    }
    browser.runtime
      .sendMessage({
        type: MSG.REPORT,
        active: report.active,
        limited: report.limited,
        media: report.media
      })
      .catch(function () {
        /* extension reloaded / tab closing */
      });
  }

  /* The page can see these messages too, so the payload is validated rather
   * than trusted; a spoofed report can at most make the popup show a wrong
   * "boost limited" note for this tab. */
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.__vmHook !== true) {
      return;
    }
    if (data.type !== 'report') {
      return;
    }
    report.active = typeof data.active === 'number' ? data.active : 0;
    report.limited = typeof data.limited === 'number' ? data.limited : 0;
    report.media = typeof data.media === 'number' ? data.media : 0;
    sendReport();
  });

  browser.runtime.onMessage.addListener(function (msg) {
    if (!msg || typeof msg.type !== 'string') {
      return undefined;
    }
    if (msg.type === MSG.APPLY) {
      tabGain = clampGain(msg.tabGain);
      pushGain();
      return undefined;
    }
    if (msg.type === MSG.PING) {
      try {
        window.postMessage({ __vmHook: true, type: 'report-request' }, '*');
      } catch (e) {
        /* ignore */
      }
      return Promise.resolve({
        type: MSG.PING,
        active: report.active,
        limited: report.limited,
        media: report.media
      });
    }
    return undefined;
  });

  function init() {
    browser.storage.local
      .get(STORAGE_MASTER)
      .then(function (stored) {
        var value = stored[STORAGE_MASTER];
        master = typeof value === 'number' ? clampGain(value) : DEFAULT_GAIN;
        pushGain();
      })
      .catch(function () {});

    browser.runtime
      .sendMessage({ type: MSG.HELLO })
      .then(function (reply) {
        if (reply && typeof reply.tabGain === 'number') {
          tabGain = clampGain(reply.tabGain);
        }
        pushGain();
      })
      .catch(function () {});
  }

  browser.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local' || !changes[STORAGE_MASTER]) {
      return;
    }
    var value = changes[STORAGE_MASTER].newValue;
    master = typeof value === 'number' ? clampGain(value) : DEFAULT_GAIN;
    pushGain();
  });

  window.addEventListener('pagehide', function () {
    extensionAlive = false;
  });

  init();
})();
