/*
 * Firefox Volume Mixer - background page.
 *
 * Responsibilities:
 *   - a volume per tab for this session, remembered per *site* (origin) in
 *     storage.local so it survives a reload, a navigation and a browser restart
 *   - the master gain in storage.local, so every frame of every tab picks it up
 *     through storage.onChanged
 *   - a per-tab registry of which tabs can play audio at all, so the popup can
 *     list a paused YouTube tab (or a page holding an embedded player) instead
 *     of only the tabs making noise right now
 *   - a state snapshot pushed to any open popup over a long-lived port
 */
'use strict';

var MSG = VM.MSG;
var STORAGE_MASTER = VM.STORAGE_MASTER;
var STORAGE_SITES = VM.STORAGE_SITES;
var PORT_NAME = VM.PORT_NAME;
var DEFAULT_GAIN = VM.DEFAULT_GAIN;
var clampGain = VM.clampGain;

/* A frame report older than this is stale: every frame re-reports about every
 * two seconds, so anything older belongs to a document that is gone. */
var REPORT_TTL = 12000;
/* How long a successful ping keeps a tab marked as controllable. */
var PING_TTL = 25000;
var SITE_SAVE_DELAY = 400;
var MAX_SITES = 500;

/* tabId -> { key, gain }: the gain this tab was last given, plus the site key
 * it belongs to, so a navigation to another site invalidates the entry. */
var tabGains = new Map();
/* site key (origin) -> remembered gain, persisted in storage.local */
var siteGains = new Map();
/* tabId -> Map(frameId -> { at, active, limited, media }) */
var frameReports = new Map();
/* tabId -> timestamp of the last successful ping */
var tabPings = new Map();
/* connected popup ports */
var popupPorts = new Set();
var stateTimer = null;
var siteSaveTimer = null;

/* ------------------------------------------------------------- site memory */

/* Only real web pages get a stable key. file:// and friends have no usable
 * origin, so their volume stays session-only. */
function siteKey(url) {
  if (typeof url !== 'string' || !url) {
    return null;
  }
  try {
    var parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch (e) {
    /* not something we can key on */
  }
  return null;
}

function scheduleSiteSave() {
  if (siteSaveTimer) {
    return;
  }
  siteSaveTimer = setTimeout(function () {
    siteSaveTimer = null;
    saveSites();
  }, SITE_SAVE_DELAY);
}

function saveSites() {
  /* Keep the map bounded: drop the least recently added entries first. */
  while (siteGains.size > MAX_SITES) {
    var oldest = siteGains.keys().next();
    if (oldest.done) {
      break;
    }
    siteGains.delete(oldest.value);
  }
  /* 100 % is the default, so those entries are not worth storing. */
  var out = {};
  siteGains.forEach(function (gain, key) {
    if (gain !== DEFAULT_GAIN) {
      out[key] = gain;
    }
  });
  var payload = {};
  payload[STORAGE_SITES] = out;
  browser.storage.local.set(payload).catch(function () {
    /* storage unavailable; the in-memory map still works for this session */
  });
}

function loadSites() {
  return browser.storage.local
    .get(STORAGE_SITES)
    .then(function (stored) {
      var saved = stored[STORAGE_SITES];
      if (!saved || typeof saved !== 'object') {
        return;
      }
      Object.keys(saved).forEach(function (key) {
        var gain = Number(saved[key]);
        if (isFinite(gain)) {
          siteGains.set(key, clampGain(gain));
        }
      });
    })
    .catch(function () {});
}

/* ---------------------------------------------------------------- tab gains */

/* A tab's own setting wins while the tab is still on the site it was set for;
 * otherwise fall back to whatever that site was last given. */
function getTabGain(tabId, url) {
  var key = siteKey(url);
  var entry = tabGains.get(tabId);
  if (entry && entry.key === key) {
    return entry.gain;
  }
  if (key && siteGains.has(key)) {
    return siteGains.get(key);
  }
  return DEFAULT_GAIN;
}

function setTabGain(tabId, url, gain) {
  var key = siteKey(url);
  tabGains.set(tabId, { key: key, gain: gain });
  if (key) {
    siteGains.set(key, gain);
    scheduleSiteSave();
  }
}

/* ----------------------------------------------------------------- reports */

function storeReport(tabId, frameId, data) {
  var frames = frameReports.get(tabId);
  if (!frames) {
    frames = new Map();
    frameReports.set(tabId, frames);
  }
  frames.set(frameId, {
    at: Date.now(),
    active: Number(data.active) || 0,
    limited: Number(data.limited) || 0,
    media: Number(data.media) || 0
  });
}

/* Sum a tab's live per-frame reports. 'media' is how many playable media
 * elements those frames hold, playing or not. */
function readReport(tabId) {
  var frames = frameReports.get(tabId);
  if (!frames) {
    return null;
  }
  var now = Date.now();
  var total = { active: 0, limited: 0, media: 0 };
  var live = false;
  frames.forEach(function (entry, frameId) {
    if (now - entry.at > REPORT_TTL) {
      frames.delete(frameId);
      return;
    }
    live = true;
    total.active += entry.active;
    total.limited += entry.limited;
    total.media += entry.media;
  });
  if (!frames.size) {
    frameReports.delete(tabId);
  }
  return live ? total : null;
}

function markPinged(tabId) {
  tabPings.set(tabId, Date.now());
}

function isPingFresh(tabId) {
  var at = tabPings.get(tabId);
  return typeof at === 'number' && Date.now() - at <= PING_TTL;
}

/* -------------------------------------------------------------------- state */

function getMaster() {
  return browser.storage.local
    .get(STORAGE_MASTER)
    .then(function (stored) {
      var value = stored[STORAGE_MASTER];
      return typeof value === 'number' ? clampGain(value) : DEFAULT_GAIN;
    })
    .catch(function () {
      return DEFAULT_GAIN;
    });
}

function buildState() {
  return getMaster().then(function (master) {
    return browser.tabs
      .query({})
      .then(function (tabs) {
        var out = [];
        tabs.forEach(function (tab) {
          if (typeof tab.id !== 'number') {
            return;
          }
          if (tab.type && tab.type !== 'normal') {
            return;
          }
          var report = readReport(tab.id);
          var gain = getTabGain(tab.id, tab.url);
          var muted = !!(tab.mutedInfo && tab.mutedInfo.muted);
          var audible = !!tab.audible;
          var media = report ? report.media : 0;
          /* Listed when it is making noise, muted, turned up or down, or simply
           * holds audio it could play: a paused player, an embedded video. */
          if (!audible && !muted && gain === DEFAULT_GAIN && media === 0) {
            return;
          }
          out.push({
            tabId: tab.id,
            windowId: tab.windowId,
            index: tab.index,
            title: tab.title || tab.url || '',
            url: tab.url || '',
            favIconUrl: tab.favIconUrl || '',
            audible: audible,
            active: !!tab.active,
            muted: muted,
            gain: gain,
            media: media,
            playing: report ? report.active : 0,
            limited: report ? report.limited : 0,
            controllable: !!report || isPingFresh(tab.id)
          });
        });
        out.sort(function (a, b) {
          if (a.active !== b.active) {
            return a.active ? -1 : 1;
          }
          if (a.audible !== b.audible) {
            return a.audible ? -1 : 1;
          }
          if ((a.media > 0) !== (b.media > 0)) {
            return a.media > 0 ? -1 : 1;
          }
          if (a.windowId !== b.windowId) {
            return a.windowId - b.windowId;
          }
          return a.index - b.index;
        });
        return { master: master, tabs: out };
      })
      .catch(function () {
        return { master: master, tabs: [] };
      });
  });
}

function pushState() {
  return buildState().then(function (nextState) {
    popupPorts.forEach(function (port) {
      try {
        port.postMessage({ type: MSG.STATE, state: nextState });
      } catch (e) {
        /* port is gone; it removes itself on disconnect */
      }
    });
  });
}

function scheduleState() {
  if (stateTimer) {
    return;
  }
  stateTimer = setTimeout(function () {
    stateTimer = null;
    pushState();
  }, 120);
}

/* ----------------------------------------------------------------- pushing */

function pushGainToTab(tabId, url) {
  return browser.tabs
    .sendMessage(tabId, { type: MSG.APPLY, tabGain: getTabGain(tabId, url) })
    .catch(function () {
      /* no content script there (about:, PDF viewer, permission denied) */
    });
}

function pingTab(tabId) {
  return browser.tabs
    .sendMessage(tabId, { type: MSG.PING })
    .then(function (reply) {
      if (reply && reply.type === MSG.PING) {
        markPinged(tabId);
      }
    })
    .catch(function () {});
}

/* Ask every tab the popup could list to answer, which also nudges its hook to
 * re-report. Runs when a popup connects. */
function refreshReports() {
  return browser.tabs
    .query({})
    .then(function (tabs) {
      var targets = tabs.filter(function (tab) {
        if (typeof tab.id !== 'number') {
          return false;
        }
        if (tab.type && tab.type !== 'normal') {
          return false;
        }
        return !!tab.audible || readReport(tab.id) !== null;
      });
      return Promise.all(
        targets.map(function (tab) {
          return pingTab(tab.id);
        })
      );
    })
    .catch(function () {});
}

/* ------------------------------------------------------------------- badge */

/* The toolbar badge shows the volume of the tab you are looking at. Browsers
 * only render a per-tab badge while that tab is the selected one, so setting
 * the right text on every tab is enough: no window-focus tracking needed. */
var DEFAULT_TITLE = 'Volume Mixer';
var BOOST_BADGE_COLOR = '#8f6bff';
var PLAIN_BADGE_COLOR = '#52525e';
var BADGE_TEXT_COLOR = '#ffffff';

function ignore(result) {
  if (result && typeof result.catch === 'function') {
    result.catch(function () {});
  }
}

function safeCall(fn) {
  try {
    ignore(fn());
  } catch (e) {
    /* the tab is gone, or the toolbar button is not available */
  }
}

function setBadge(tabId, text, color, title) {
  safeCall(function () {
    return browser.browserAction.setBadgeText({ tabId: tabId, text: text });
  });
  if (text) {
    safeCall(function () {
      return browser.browserAction.setBadgeBackgroundColor({ tabId: tabId, color: color });
    });
    if (typeof browser.browserAction.setBadgeTextColor === 'function') {
      safeCall(function () {
        return browser.browserAction.setBadgeTextColor({
          tabId: tabId,
          color: BADGE_TEXT_COLOR
        });
      });
    }
  }
  safeCall(function () {
    return browser.browserAction.setTitle({ tabId: tabId, title: title });
  });
}

/* 'M' when the tab is muted, the percentage when it is not at 100 %, nothing
 * otherwise. Boosted tabs get the accent colour so >100 % is visible at a
 * glance. */
function updateTabBadge(tabId, url, muted) {
  var percent = Math.round(getTabGain(tabId, url) * 100);
  var text = '';
  var color = PLAIN_BADGE_COLOR;
  var title = DEFAULT_TITLE;
  if (muted) {
    text = 'M';
    title = DEFAULT_TITLE + ' - muted';
  } else if (percent !== 100) {
    text = String(percent);
    title = DEFAULT_TITLE + ' - ' + percent + ' %';
    if (percent > 100) {
      color = BOOST_BADGE_COLOR;
    }
  }
  setBadge(tabId, text, color, title);
}

function refreshAllBadges() {
  return browser.tabs
    .query({})
    .then(function (tabs) {
      tabs.forEach(function (tab) {
        if (typeof tab.id !== 'number') {
          return;
        }
        updateTabBadge(tab.id, tab.url, !!(tab.mutedInfo && tab.mutedInfo.muted));
      });
    })
    .catch(function () {});
}

/* ---------------------------------------------------------------- commands */

function handleCommand(msg) {
  if (!msg || typeof msg.type !== 'string') {
    return Promise.resolve();
  }
  var tabId = msg.tabId;

  switch (msg.type) {
    case MSG.GET_STATE:
      return pushState();

    case MSG.SET_TAB_GAIN:
      if (typeof tabId !== 'number') {
        return Promise.resolve();
      }
      return browser.tabs
        .get(tabId)
        .then(function (tab) {
          setTabGain(tabId, tab.url, clampGain(msg.gain));
          updateTabBadge(tabId, tab.url, !!(tab.mutedInfo && tab.mutedInfo.muted));
          return pushGainToTab(tabId, tab.url);
        })
        .catch(function () {
          setTabGain(tabId, null, clampGain(msg.gain));
          updateTabBadge(tabId, null, false);
        })
        .then(scheduleState);

    case MSG.SET_MASTER:
      return browser.storage.local
        .set({ [STORAGE_MASTER]: clampGain(msg.master) })
        .catch(function () {})
        .then(scheduleState);

    case MSG.SET_MUTED:
      if (typeof tabId !== 'number') {
        return Promise.resolve();
      }
      return browser.tabs
        .update(tabId, { muted: !!msg.muted })
        .then(function (tab) {
          updateTabBadge(tabId, tab.url, !!(tab.mutedInfo && tab.mutedInfo.muted));
        })
        .catch(function () {})
        .then(scheduleState);

    case MSG.RESET:
      /* "Reset all" also forgets the remembered per-site volumes, otherwise
       * the next page load would put them straight back. */
      tabGains.clear();
      siteGains.clear();
      scheduleSiteSave();
      return browser.storage.local
        .set({ [STORAGE_MASTER]: DEFAULT_GAIN })
        .catch(function () {})
        .then(function () {
          return browser.tabs.query({});
        })
        .then(function (tabs) {
          return Promise.all(
            tabs.map(function (tab) {
              if (typeof tab.id !== 'number') {
                return null;
              }
              var unmute =
                tab.mutedInfo && tab.mutedInfo.muted
                  ? browser.tabs.update(tab.id, { muted: false }).catch(function () {})
                  : null;
              return Promise.all([pushGainToTab(tab.id, tab.url), unmute]);
            })
          );
        })
        .then(refreshAllBadges)
        .then(scheduleState);

    default:
      return Promise.resolve();
  }
}

/* --------------------------------------------------------------- listeners */

browser.runtime.onConnect.addListener(function (port) {
  if (port.name !== PORT_NAME) {
    return;
  }
  popupPorts.add(port);
  port.onDisconnect.addListener(function () {
    popupPorts.delete(port);
  });
  port.onMessage.addListener(function (msg) {
    handleCommand(msg);
  });
  refreshReports().then(pushState);
});

browser.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || typeof msg.type !== 'string') {
    return undefined;
  }
  var tab = sender && sender.tab;
  var tabId = tab && tab.id;
  if (typeof tabId !== 'number') {
    return undefined;
  }

  if (msg.type === MSG.HELLO) {
    /* A content script just loaded and asks which volume to run at. */
    return Promise.resolve({ type: MSG.HELLO, tabGain: getTabGain(tabId, tab.url) });
  }

  if (msg.type === MSG.REPORT) {
    var frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
    storeReport(tabId, frameId, msg);
    markPinged(tabId);
    scheduleState();
    return undefined;
  }

  return undefined;
});

browser.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  var interesting = false;
  var urlChanged = changeInfo.url !== undefined;
  var mutedChanged = changeInfo.mutedInfo !== undefined;

  if (changeInfo.audible !== undefined || mutedChanged) {
    interesting = true;
    if (changeInfo.audible) {
      pingTab(tabId);
    }
  }

  if (urlChanged || mutedChanged) {
    /* The tab moved, or its mute state flipped: its badge may no longer be
     * right, and a navigation also means a different site's volume applies. */
    interesting = true;
    var handle = function (current) {
      if (!current) {
        return undefined;
      }
      updateTabBadge(tabId, current.url, !!(current.mutedInfo && current.mutedInfo.muted));
      if (urlChanged) {
        return pushGainToTab(tabId, current.url);
      }
      return undefined;
    };
    if (tab) {
      handle(tab);
    } else {
      browser.tabs
        .get(tabId)
        .then(handle)
        .catch(function () {});
    }
  }

  if (interesting) {
    scheduleState();
  }
});

browser.tabs.onRemoved.addListener(function (tabId) {
  tabGains.delete(tabId);
  frameReports.delete(tabId);
  tabPings.delete(tabId);
  scheduleState();
});

browser.tabs.onAttached.addListener(function () {
  scheduleState();
});

browser.tabs.onDetached.addListener(function () {
  scheduleState();
});

/* ------------------------------------------------------------------ startup */

loadSites().then(refreshAllBadges).then(scheduleState);
