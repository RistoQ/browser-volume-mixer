/*
 * Firefox Volume Mixer - page-world audio hook.
 *
 * This runs as a MAIN-world content script, i.e. it executes as if the page
 * itself had loaded it. That is what lets it reach the page's own audio
 * objects (HTMLMediaElement.prototype, AudioContext, AudioNode) and insert
 * gain nodes into the page's audio graph.
 *
 * It knows nothing about the extension: the isolated-world content script
 * (content/bridge.js) talks to it with window.postMessage.
 *
 *   bridge -> hook : { __vmHook: true, type: 'set', gain: <0..2> }
 *                    { __vmHook: true, type: 'report-request' }
 *   hook -> bridge : { __vmHook: true, type: 'report', active, media, limited, gain }
 *
 * How the volume is applied
 * -------------------------
 *   gain <= 1   : element.volume = naturalVolume * gain   (native, works everywhere)
 *   gain > 1    : the element is routed through a GainNode
 *                   a) if the page already called createMediaElementSource(),
 *                      we splice our gain node into *its* graph, or
 *                   b) otherwise we create our own AudioContext for the
 *                      document and route the element into it.
 *                 Elements that cannot be routed (cross-origin media without
 *                 CORS, DRM/EME protected streams) keep the native path and
 *                 are reported as "limited" so the popup can warn about them.
 */
(function () {
  'use strict';

  var W = window;
  var GUARD = '__ff_volume_mixer_hook__';

  if (W[GUARD]) {
    return;
  }
  try {
    W[GUARD] = true;
  } catch (e) {
    return;
  }

  var MIN_GAIN = 0;
  var MAX_GAIN = 2;
  var SCAN_INTERVAL = 2000;
  var REPORT_DELAY = 250;

  var mediaProto = W.HTMLMediaElement && W.HTMLMediaElement.prototype;
  if (!mediaProto) {
    return;
  }

  var gain = 1;                       /* effective gain = tabGain * master */
  var active = new Set();             /* media elements currently playing */
  var elementState = new WeakMap();   /* element -> state record           */
  var gainNodes = new WeakMap();      /* MEASN  -> our GainNode            */
  var ownCtx = null;                  /* AudioContext we created, if any   */
  var resumeListenerBound = false;
  var reportTimer = null;
  var mediaCount = 0;                 /* playable media elements in the document */

  /* ------------------------------------------------------------- helpers */

  function clamp01(v) {
    if (!isFinite(v)) {
      return 0;
    }
    if (v < 0) {
      return 0;
    }
    if (v > 1) {
      return 1;
    }
    return v;
  }

  function clampGain(v) {
    if (!isFinite(v)) {
      return 0;
    }
    if (v < MIN_GAIN) {
      return MIN_GAIN;
    }
    if (v > MAX_GAIN) {
      return MAX_GAIN;
    }
    return v;
  }

  function isPlaying(el) {
    return !el.paused && !el.ended;
  }

  /* Media this page could play right now, playing or not: that is what makes
   * a tab "audio-capable" in the popup even while it is paused. */
  function isPlayable(el) {
    if (el.srcObject) {
      return true;
    }
    return !!(el.currentSrc || el.src);
  }

  /* ------------------------------------------------- element volume patch */

  var volumeDesc = Object.getOwnPropertyDescriptor(mediaProto, 'volume');

  function readVolume(el) {
    if (volumeDesc && volumeDesc.get) {
      return volumeDesc.get.call(el);
    }
    return el.volume;
  }

  function writeVolume(el, value) {
    var v = clamp01(value);
    if (volumeDesc && volumeDesc.set) {
      volumeDesc.set.call(el, v);
    } else {
      el.volume = v;
    }
  }

  if (volumeDesc && volumeDesc.get && volumeDesc.set) {
    try {
      Object.defineProperty(mediaProto, 'volume', {
        configurable: true,
        enumerable: volumeDesc.enumerable,
        get: function () {
          var st = elementState.get(this);
          if (st) {
            return st.natural;
          }
          return volumeDesc.get.call(this);
        },
        set: function (value) {
          var st = elementState.get(this);
          if (!st) {
            st = register(this);
          }
          var v = Number(value);
          if (!isFinite(v)) {
            v = 1;
          }
          v = clamp01(v);
          if (!st) {
            volumeDesc.set.call(this, v);
            return;
          }
          st.natural = v;
          /* While the element is routed the gain node owns the level, so the
           * element keeps the volume the page asked for. */
          volumeDesc.set.call(this, st.routed ? v : clamp01(v * gain));
        }
      });
    } catch (e) {
      /* leave the native property alone */
    }
  }

  /* ------------------------------------------------------- element tracking */

  function register(el) {
    if (!el || !(el instanceof W.HTMLMediaElement)) {
      return null;
    }
    var existing = elementState.get(el);
    if (existing) {
      return existing;
    }
    var st = {
      natural: readVolume(el),
      routed: false,
      ownRoute: false,   /* true when the routing is ours, not the page's */
      node: null,
      limited: false,    /* cannot be boosted (cross-origin / DRM)         */
      pending: false,    /* boost requested but the AudioContext is not running yet */
      eme: false         /* setMediaKeys() has been called on this element */
    };
    elementState.set(el, st);

    var onStart = function () {
      active.add(el);
      applyElement(el, st);
      scheduleReport();
    };
    var onStop = function () {
      active.delete(el);
      scheduleReport();
    };
    var onReset = function () {
      if (!st.routed) {
        st.limited = false;
        st.pending = false;
      }
      applyElement(el, st);
      scheduleReport();
    };

    el.addEventListener('play', onStart);
    el.addEventListener('pause', onStop);
    el.addEventListener('ended', onStop);
    el.addEventListener('emptied', onReset);
    el.addEventListener('loadstart', onReset);

    if (isPlaying(el)) {
      active.add(el);
      applyElement(el, st);
    }
    return st;
  }

  /* ------------------------------------------------------ routing decisions */

  /* 'ok' | 'pending' | 'blocked' */
  function routeDecision(el, st) {
    if (st.eme) {
      return 'blocked';
    }
    if (el.srcObject) {
      return 'ok';
    }
    var src = el.currentSrc || el.src || '';
    if (!src) {
      return 'pending';
    }
    var url;
    try {
      url = new URL(src, W.location.href);
    } catch (e) {
      return 'pending';
    }
    var protocol = url.protocol;
    if (
      protocol === 'blob:' ||
      protocol === 'data:' ||
      protocol === 'mediastream:' ||
      protocol === 'filesystem:' ||
      protocol === 'about:'
    ) {
      return 'ok';
    }
    if (url.origin === W.location.origin) {
      return 'ok';
    }
    /* Cross-origin: only safe when the element asked for CORS. */
    var crossOrigin = el.crossOrigin;
    if (crossOrigin === 'anonymous' || crossOrigin === 'use-credentials') {
      return 'ok';
    }
    return 'blocked';
  }

  /* 'ok' | 'pending' | 'unavailable' */
  function boostContextState() {
    if (!ownCtx || ownCtx.state === 'closed') {
      var AudioCtor = W.AudioContext || W.webkitAudioContext;
      if (!AudioCtor) {
        return 'unavailable';
      }
      try {
        ownCtx = new AudioCtor();
      } catch (e) {
        ownCtx = null;
        return 'unavailable';
      }
      try {
        ownCtx.addEventListener('statechange', onContextStateChange);
      } catch (e) {
        ownCtx.onstatechange = onContextStateChange;
      }
    }
    if (ownCtx.state === 'running') {
      return 'ok';
    }
    resumeContext();
    return 'pending';
  }

  function resumeContext() {
    if (!ownCtx) {
      return;
    }
    try {
      var promise = ownCtx.resume();
      if (promise && promise.catch) {
        promise.catch(function () {});
      }
    } catch (e) {
      /* ignore */
    }
    if (resumeListenerBound) {
      return;
    }
    resumeListenerBound = true;
    var handler = function () {
      if (ownCtx && ownCtx.state !== 'running') {
        try {
          ownCtx.resume();
        } catch (e) {
          /* ignore */
        }
      }
      retryPending();
    };
    ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(function (type) {
      try {
        W.addEventListener(type, handler, true);
      } catch (e) {
        /* ignore */
      }
    });
  }

  function onContextStateChange() {
    retryPending();
  }

  function retryPending() {
    if (!ownCtx || ownCtx.state !== 'running') {
      return;
    }
    active.forEach(function (el) {
      var st = elementState.get(el);
      if (st && st.pending && !st.routed) {
        st.pending = false;
        applyElement(el, st);
      }
    });
    scheduleReport();
  }

  function routeIntoOwnContext(el, st) {
    var src;
    try {
      src = ownCtx.createMediaElementSource(el);
    } catch (e) {
      return false;
    }
    var node;
    try {
      node = ownCtx.createGain();
      node.gain.value = el.muted ? 0 : gain;
      src.connect(node);
      node.connect(ownCtx.destination);
    } catch (e) {
      return false;
    }
    st.routed = true;
    st.ownRoute = true;
    st.node = node;
    st.pending = false;
    writeVolume(el, st.natural);
    return true;
  }

  /* ----------------------------------------------------------- apply gain */

  function applyElement(el, st) {
    if (st.routed) {
      if (st.node) {
        try {
          st.node.gain.value = el.muted ? 0 : gain;
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }
    if (gain <= 1) {
      writeVolume(el, st.natural * gain);
      return;
    }
    /* Boost requested but the element is not routed yet. */
    if (st.limited) {
      writeVolume(el, st.natural);
      return;
    }
    var decision = routeDecision(el, st);
    if (decision === 'blocked') {
      st.limited = true;
      writeVolume(el, st.natural);
      return;
    }
    if (decision === 'pending') {
      st.pending = true;
      writeVolume(el, st.natural);
      return;
    }
    var contextState = boostContextState();
    if (contextState === 'unavailable') {
      st.limited = true;
      writeVolume(el, st.natural);
      return;
    }
    if (contextState === 'pending') {
      st.pending = true;
      writeVolume(el, st.natural);
      return;
    }
    if (!routeIntoOwnContext(el, st)) {
      st.limited = true;
      writeVolume(el, st.natural);
    }
  }

  function applyGain() {
    active.forEach(function (el) {
      var st = elementState.get(el);
      if (st) {
        applyElement(el, st);
      }
    });
    scheduleReport();
  }

  /* ---------------------------------------------------------------- patch */

  /* HTMLMediaElement.play() */
  var originalPlay = mediaProto.play;
  if (typeof originalPlay === 'function') {
    mediaProto.play = function () {
      register(this);
      return originalPlay.apply(this, arguments);
    };
  }

  /* AudioContext.createMediaElementSource() - the page's own audio graph. */
  function patchContext(AudioCtor) {
    var proto = AudioCtor && AudioCtor.prototype;
    if (!proto || typeof proto.createMediaElementSource !== 'function') {
      return;
    }
    if (proto.createMediaElementSource.__vmPatched) {
      return;
    }
    var original = proto.createMediaElementSource;
    var patched = function (element) {
      var st = elementState.get(element);
      if (st && st.routed && st.ownRoute) {
        /* The element is already routed through our own AudioContext; the
         * real API would throw here. Hand the page a harmless stand-in so
         * its player code does not blow up. */
        return makeStandIn(element);
      }
      var src = original.call(this, element);
      try {
        spliceGain(this, src, element);
      } catch (e) {
        /* ignore */
      }
      return src;
    };
    patched.__vmPatched = true;
    try {
      proto.createMediaElementSource = patched;
    } catch (e) {
      /* ignore */
    }
  }

  function makeStandIn(element) {
    return {
      context: ownCtx,
      mediaElement: element,
      numberOfInputs: 0,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      connect: function (dest) {
        return dest;
      },
      disconnect: function () {}
    };
  }

  /* Insert our GainNode between the page's MediaElementAudioSourceNode and
   * whatever it connects to. */
  function spliceGain(ctx, src, element) {
    var st = register(element);
    var node;
    try {
      node = ctx.createGain();
      node.gain.value = element.muted ? 0 : gain;
    } catch (e) {
      return;
    }
    gainNodes.set(src, { node: node, linked: false, targets: new Set() });
    if (st) {
      st.routed = true;
      st.ownRoute = false;
      st.node = node;
      st.limited = false;
      st.pending = false;
      writeVolume(element, st.natural);
    }
    if (isPlaying(element)) {
      active.add(element);
    }
    scheduleReport();
  }

  /* AudioNode.prototype.connect() - redirect the page's connects to our node. */
  var AudioNodeProto = W.AudioNode && W.AudioNode.prototype;
  if (AudioNodeProto && typeof AudioNodeProto.connect === 'function') {
    var originalConnect = AudioNodeProto.connect;
    var originalDisconnect = AudioNodeProto.disconnect;

    AudioNodeProto.connect = function (destination, output, input) {
      var record = gainNodes.get(this);
      if (record && destination !== record.node && destination instanceof W.AudioNode) {
        try {
          if (!record.linked) {
            originalConnect.call(this, record.node);
            record.linked = true;
          }
          if (!record.targets.has(destination)) {
            record.targets.add(destination);
            originalConnect.call(record.node, destination, output, input);
          }
          return destination;
        } catch (e) {
          /* fall through to the plain connect below */
        }
      }
      return originalConnect.call(this, destination, output, input);
    };

    AudioNodeProto.disconnect = function () {
      var record = gainNodes.get(this);
      var result = originalDisconnect.apply(this, arguments);
      if (record) {
        record.linked = false;
      }
      return result;
    };
  }

  /* HTMLMediaElement.setMediaKeys() - DRM streams are never re-routed. */
  var originalSetMediaKeys = mediaProto.setMediaKeys;
  if (typeof originalSetMediaKeys === 'function') {
    mediaProto.setMediaKeys = function () {
      var st = register(this);
      if (st) {
        st.eme = true;
        if (gain > 1 && !st.routed) {
          st.limited = true;
          writeVolume(this, st.natural);
        }
      }
      return originalSetMediaKeys.apply(this, arguments);
    };
  }

  /* document.createElement() and the Audio() constructor catch elements that
   * never go through HTMLMediaElement.play(). */
  var DocumentProto = W.Document && W.Document.prototype;
  if (DocumentProto && typeof DocumentProto.createElement === 'function') {
    var originalCreateElement = DocumentProto.createElement;
    DocumentProto.createElement = function () {
      var el = originalCreateElement.apply(this, arguments);
      if (el && (el.tagName === 'AUDIO' || el.tagName === 'VIDEO')) {
        register(el);
      }
      return el;
    };
  }

  if (typeof W.Audio === 'function') {
    var OriginalAudio = W.Audio;
    var AudioProxy = function () {
      var el = new OriginalAudio(...arguments);
      register(el);
      return el;
    };
    AudioProxy.prototype = OriginalAudio.prototype;
    try {
      W.Audio = AudioProxy;
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------ element discovery */

  var observer = null;

  function observeRoot(root) {
    if (!root || !W.MutationObserver) {
      return;
    }
    try {
      var obs = new W.MutationObserver(handleMutations);
      obs.observe(root, { childList: true, subtree: true });
    } catch (e) {
      return;
    }
    if (root === W.document && !observer) {
      observer = obs;
    }
  }

  function handleMutations(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        inspectNode(added[j]);
      }
    }
    scheduleReport();
  }

  function inspectNode(node) {
    if (!node || node.nodeType !== 1) {
      return;
    }
    var tag = node.tagName;
    if (tag === 'AUDIO' || tag === 'VIDEO') {
      register(node);
    } else if (node.querySelectorAll) {
      collect(node.querySelectorAll('audio,video'));
    }
    if (node.shadowRoot) {
      observeRoot(node.shadowRoot);
      if (node.shadowRoot.querySelectorAll) {
        collect(node.shadowRoot.querySelectorAll('audio,video'));
      }
    }
  }

  function collect(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      register(nodes[i]);
    }
  }

  function scan() {
    var nodes = null;
    try {
      nodes = W.document.querySelectorAll('audio,video');
    } catch (e) {
      nodes = null;
    }
    if (nodes) {
      collect(nodes);
      var playable = 0;
      for (var i = 0; i < nodes.length; i++) {
        if (isPlayable(nodes[i])) {
          playable++;
        }
      }
      mediaCount = playable;
    }
    active.forEach(function (el) {
      if (!isPlaying(el)) {
        active.delete(el);
      }
    });
  }

  var ElementProto = W.Element && W.Element.prototype;
  if (ElementProto && typeof ElementProto.attachShadow === 'function') {
    var originalAttachShadow = ElementProto.attachShadow;
    ElementProto.attachShadow = function () {
      var shadowRoot = originalAttachShadow.apply(this, arguments);
      observeRoot(shadowRoot);
      return shadowRoot;
    };
  }

  /* --------------------------------------------------------------- reports */

  function scheduleReport() {
    if (reportTimer) {
      return;
    }
    reportTimer = setTimeout(function () {
      reportTimer = null;
      postReport();
    }, REPORT_DELAY);
  }

  function postReport() {
    var limited = 0;
    active.forEach(function (el) {
      var st = elementState.get(el);
      if (st && st.limited) {
        limited++;
      }
    });
    try {
      W.postMessage(
        {
          __vmHook: true,
          type: 'report',
          active: active.size,
          limited: limited,
          media: mediaCount,
          gain: gain
        },
        '*'
      );
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------- messaging */

  W.addEventListener('message', function (event) {
    if (event.source !== W) {
      return;
    }
    var data = event.data;
    if (!data || typeof data !== 'object' || data.__vmHook !== true) {
      return;
    }
    if (data.type === 'set') {
      var next = clampGain(Number(data.gain));
      if (next === gain) {
        return;
      }
      gain = next;
      applyGain();
    } else if (data.type === 'report-request') {
      postReport();
    }
  });

  /* ---------------------------------------------------------------- startup */

  observeRoot(W.document);
  scan();
  if (W.document.readyState === 'loading') {
    W.document.addEventListener('DOMContentLoaded', scan);
  }
  setInterval(function () {
    scan();
    applyGain();
  }, SCAN_INTERVAL);

  patchContext(W.AudioContext);
  patchContext(W.webkitAudioContext);

  postReport();
})();
