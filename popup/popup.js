/*
 * Firefox Volume Mixer - popup.
 *
 * Talks to the background page over a long-lived port: it sends commands
 * (set tab gain / set master / mute / reset) and receives the whole mixer
 * state, which it reconciles into the existing rows so that dragging a
 * slider is never interrupted by a re-render.
 *
 * Every control moves in 5 % steps: the sliders are step="5", the -5 % / +5 %
 * buttons step by STEP_PERCENT, typed values are snapped to the same grid,
 * and the number inputs' native spinner arrows are hidden in CSS.
 */
'use strict';

var MSG = VM.MSG;
var PORT_NAME = VM.PORT_NAME;
var MAX_PERCENT = Math.round(VM.MAX_GAIN * 100);
var STEP_PERCENT = 5;
var SEND_DELAY = 60;
var MINUS = '\u2212';

var tabList = document.getElementById('tabs');
var emptyMsg = document.getElementById('empty');
var statusEl = document.getElementById('status');
var masterRange = document.getElementById('master-range');
var masterNumber = document.getElementById('master-number');
var masterValue = document.getElementById('master-value');
var masterDec = document.getElementById('master-dec');
var masterInc = document.getElementById('master-inc');
var resetButton = document.getElementById('reset');

var rows = new Map();
var pendingTabSends = new Map();
var masterTimer = null;
var orderSignature = '';
var port = null;
var state = { master: 1, tabs: [] };

/* --------------------------------------------------------------- plumbing */

function send(message) {
  if (!port) {
    return;
  }
  try {
    port.postMessage(message);
  } catch (e) {
    showStatus('Lost the connection to the extension - close and reopen the popup.');
  }
}

function showStatus(text) {
  statusEl.textContent = text || '';
}

function connect() {
  try {
    port = browser.runtime.connect({ name: PORT_NAME });
  } catch (e) {
    showStatus('Could not reach the extension - close and reopen the popup.');
    return;
  }
  port.onMessage.addListener(function (message) {
    if (message && message.type === MSG.STATE) {
      state = message.state;
      render();
    }
  });
  port.onDisconnect.addListener(function () {
    port = null;
    showStatus('Extension reloaded - close and reopen the popup.');
  });
}

function scheduleTabGain(tabId, percent) {
  var existing = pendingTabSends.get(tabId);
  if (existing) {
    clearTimeout(existing);
  }
  pendingTabSends.set(
    tabId,
    setTimeout(function () {
      pendingTabSends.delete(tabId);
      send({ type: MSG.SET_TAB_GAIN, tabId: tabId, gain: percent / 100 });
    }, SEND_DELAY)
  );
}

function scheduleMaster(percent) {
  if (masterTimer) {
    clearTimeout(masterTimer);
  }
  masterTimer = setTimeout(function () {
    masterTimer = null;
    send({ type: MSG.SET_MASTER, master: percent / 100 });
  }, SEND_DELAY);
}

function findTab(tabId) {
  for (var i = 0; i < state.tabs.length; i++) {
    if (state.tabs[i].tabId === tabId) {
      return state.tabs[i];
    }
  }
  return null;
}

/* Snap to the 5 % grid, clamped to 0..MAX_PERCENT (200 sits on the grid). */
function snapPercent(value) {
  var n = Math.round(Number(value));
  if (!isFinite(n)) {
    return 100;
  }
  if (n < 0) {
    n = 0;
  }
  if (n > MAX_PERCENT) {
    n = MAX_PERCENT;
  }
  return Math.round(n / STEP_PERCENT) * STEP_PERCENT;
}

/* ------------------------------------------------------------------ rows */

function createRow(tabId) {
  var root = document.createElement('li');
  root.className = 'row';

  var head = document.createElement('div');
  head.className = 'row-head';

  var icon = document.createElement('img');
  icon.className = 'favicon';
  icon.alt = '';
  icon.addEventListener('error', function () {
    icon.classList.add('placeholder');
    icon.removeAttribute('src');
  });

  var meta = document.createElement('div');
  meta.className = 'meta';

  var title = document.createElement('div');
  title.className = 'title';

  var note = document.createElement('div');
  note.className = 'note';
  note.hidden = true;

  meta.appendChild(title);
  meta.appendChild(note);

  var hundred = document.createElement('button');
  hundred.className = 'hundred';
  hundred.type = 'button';
  hundred.textContent = '100%';
  hundred.title = 'Reset this tab to 100%';

  var mute = document.createElement('button');
  mute.className = 'mute';
  mute.type = 'button';

  head.appendChild(icon);
  head.appendChild(meta);
  head.appendChild(hundred);
  head.appendChild(mute);

  var stepper = document.createElement('div');
  stepper.className = 'stepper';

  var dec = document.createElement('button');
  dec.className = 'step';
  dec.type = 'button';
  dec.textContent = MINUS + STEP_PERCENT + '%';
  dec.title = 'Decrease this tab by ' + STEP_PERCENT + '%';

  var range = document.createElement('input');
  range.className = 'range';
  range.type = 'range';
  range.min = '0';
  range.max = String(MAX_PERCENT);
  range.step = String(STEP_PERCENT);
  range.setAttribute('aria-label', 'Tab volume');

  var inc = document.createElement('button');
  inc.className = 'step';
  inc.type = 'button';
  inc.textContent = '+' + STEP_PERCENT + '%';
  inc.title = 'Increase this tab by ' + STEP_PERCENT + '%';

  var number = document.createElement('input');
  number.className = 'number';
  number.type = 'number';
  number.min = '0';
  number.max = String(MAX_PERCENT);
  number.step = String(STEP_PERCENT);
  number.setAttribute('aria-label', 'Tab volume percent');

  stepper.appendChild(dec);
  stepper.appendChild(range);
  stepper.appendChild(inc);
  stepper.appendChild(number);

  root.appendChild(head);
  root.appendChild(stepper);

  var row = {
    tabId: tabId,
    root: root,
    icon: icon,
    title: title,
    note: note,
    hundred: hundred,
    mute: mute,
    dec: dec,
    range: range,
    inc: inc,
    number: number,
    faviconUrl: null,
    titleText: null,
    muted: null,
    noteText: null
  };

  /* Snap to the grid, push it into both controls and send it. */
  function setPercent(percent) {
    var snapped = snapPercent(percent);
    row.range.value = String(snapped);
    if (document.activeElement !== row.number) {
      row.number.value = String(snapped);
    }
    scheduleTabGain(tabId, snapped);
  }

  dec.addEventListener('click', function () {
    setPercent(Number(row.range.value) - STEP_PERCENT);
  });

  inc.addEventListener('click', function () {
    setPercent(Number(row.range.value) + STEP_PERCENT);
  });

  hundred.addEventListener('click', function () {
    setPercent(100);
  });

  range.addEventListener('input', function () {
    setPercent(range.value);
  });

  number.addEventListener('change', function () {
    var percent = snapPercent(number.value);
    number.value = String(percent);
    row.range.value = String(percent);
    scheduleTabGain(tabId, percent);
  });
  number.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      number.blur();
    }
  });

  mute.addEventListener('click', function () {
    var tab = findTab(tabId);
    send({ type: MSG.SET_MUTED, tabId: tabId, muted: !(tab && tab.muted) });
  });

  return row;
}

function updateRow(row, tab) {
  var percent = Math.round(tab.gain * 100);
  var busy = pendingTabSends.has(tab.tabId);

  if (row.titleText !== tab.title) {
    row.titleText = tab.title;
    row.title.textContent = tab.title;
  }

  if (row.faviconUrl !== (tab.favIconUrl || '')) {
    row.faviconUrl = tab.favIconUrl || '';
    if (row.faviconUrl) {
      row.icon.classList.remove('placeholder');
      row.icon.src = row.faviconUrl;
    } else {
      row.icon.removeAttribute('src');
      row.icon.classList.add('placeholder');
    }
  }

  if (row.muted !== tab.muted) {
    row.muted = tab.muted;
    row.mute.textContent = tab.muted ? 'Unmute' : 'Mute';
    row.mute.classList.toggle('muted', tab.muted);
    row.mute.title = tab.muted ? 'Unmute this tab' : 'Mute this tab';
  }

  var noteText = '';
  if (!tab.controllable) {
    noteText = 'Not controllable - this page cannot be scripted';
  } else if (tab.limited > 0 && percent > 100) {
    noteText = 'Boost limited here - cross-origin or DRM audio falls back to 100%';
  }
  if (row.noteText !== noteText) {
    row.noteText = noteText;
    row.note.textContent = noteText;
    row.note.hidden = !noteText;
  }

  row.range.disabled = !tab.controllable;
  row.number.disabled = !tab.controllable;
  row.dec.disabled = !tab.controllable;
  row.inc.disabled = !tab.controllable;
  row.hundred.disabled = !tab.controllable;

  if (!busy && document.activeElement !== row.range) {
    row.range.value = String(percent);
  }
  if (!busy && document.activeElement !== row.number) {
    row.number.value = String(percent);
  }

  row.root.classList.toggle('silent', !tab.audible);
}

function render() {
  renderMaster();

  var seen = new Set();
  var order = [];
  state.tabs.forEach(function (tab) {
    seen.add(tab.tabId);
    order.push(tab.tabId);
    var row = rows.get(tab.tabId);
    if (!row) {
      row = createRow(tab.tabId);
      rows.set(tab.tabId, row);
      tabList.appendChild(row.root);
    }
    updateRow(row, tab);
  });

  Array.from(rows.keys()).forEach(function (tabId) {
    if (!seen.has(tabId)) {
      var row = rows.get(tabId);
      if (row) {
        row.root.remove();
      }
      rows.delete(tabId);
    }
  });

  /* Reorder only when the order really changed: moving a node in the DOM
   * while the user drags its slider would abort the drag. */
  var signature = order.join(',');
  if (signature !== orderSignature) {
    orderSignature = signature;
    order.forEach(function (tabId) {
      var row = rows.get(tabId);
      if (row) {
        tabList.appendChild(row.root);
      }
    });
  }

  emptyMsg.hidden = state.tabs.length > 0;

  var playing = 0;
  state.tabs.forEach(function (tab) {
    if (tab.audible) {
      playing++;
    }
  });
  if (!state.tabs.length) {
    showStatus('');
  } else if (playing === state.tabs.length) {
    showStatus(state.tabs.length + ' tab(s), all playing');
  } else {
    showStatus(state.tabs.length + ' tab(s), ' + playing + ' playing');
  }
}

/* ---------------------------------------------------------------- master */

function renderMaster() {
  var percent = Math.round(state.master * 100);
  masterValue.textContent = percent + '%';
  if (!masterTimer && document.activeElement !== masterRange) {
    masterRange.value = String(percent);
  }
  if (document.activeElement !== masterNumber) {
    masterNumber.value = String(percent);
  }
}

function setMasterPercent(percent) {
  var snapped = snapPercent(percent);
  masterRange.value = String(snapped);
  if (document.activeElement !== masterNumber) {
    masterNumber.value = String(snapped);
  }
  masterValue.textContent = snapped + '%';
  scheduleMaster(snapped);
}

masterDec.addEventListener('click', function () {
  setMasterPercent(Number(masterRange.value) - STEP_PERCENT);
});

masterInc.addEventListener('click', function () {
  setMasterPercent(Number(masterRange.value) + STEP_PERCENT);
});

masterRange.addEventListener('input', function () {
  setMasterPercent(masterRange.value);
});

masterNumber.addEventListener('change', function () {
  setMasterPercent(masterNumber.value);
});

masterNumber.addEventListener('keydown', function (event) {
  if (event.key === 'Enter') {
    masterNumber.blur();
  }
});

resetButton.addEventListener('click', function () {
  pendingTabSends.forEach(function (timer) {
    clearTimeout(timer);
  });
  pendingTabSends.clear();
  if (masterTimer) {
    clearTimeout(masterTimer);
    masterTimer = null;
  }
  send({ type: MSG.RESET });
});

connect();
