'use strict';

hterm.Terminal.prototype.onFocusChange_ = function(focused) {};

hterm.Terminal.prototype.onFocusChange__ = function(focused) {
  var currentState = this.cursorNode_.getAttribute('focus');
  if (currentState === focused + '') {
    return;
  }

  this.cursorNode_.setAttribute('focus', focused);
  this.restyleCursor_();

  if (this.reportFocus) {
    this.io.sendString(focused === true ? '\x1b[I' : '\x1b[O');
  }

  if (focused === true) this.closeBellNotifications_();
};

// Do not show resize notifications. We show ours
hterm.Terminal.prototype.overlaySize = function() {};

hterm.Terminal.prototype.onMouse_ = function() {};

// TODO: Remove our patch. htermjs supports cursorBlinkPause_ option now
// see https://github.com/chromium/hterm/commit/f57d62de8f91f1fc8923fb000aeace041d063f9f
hterm.Terminal.prototype.setCursorVisible = function(state) {
  this.options_.cursorVisible = state;

  if (!state) {
    if (this.timeouts_.cursorBlink) {
      clearTimeout(this.timeouts_.cursorBlink);
      delete this.timeouts_.cursorBlink;
    }
    this.cursorNode_.style.opacity = '0';
    return;
  }

  this.syncCursorPosition_();

  this.cursorNode_.style.opacity = '1';

  if (this.options_.cursorBlink) {
    if (this.timeouts_.cursorBlink) return;

    // Blink: Switch the cursor off, so that the manual (first) blink trigger sets it on again
    this.cursorNode_.style.opacity = '0';
    this.onCursorBlink_();
  } else {
    if (this.timeouts_.cursorBlink) {
      clearTimeout(this.timeouts_.cursorBlink);
      delete this.timeouts_.cursorBlink;
    }
  }
};

// NOTE(@nanzhong) hterm does not support DEC mode 1003 (any mouse event reporting mode).
// DEC mode 1003 and DEC mode 1002 (which hterm does support) are almost identical. The only difference is that mode 1003 includes mouse movement tracking events which are rarely used.
// This patches hterm to treat DEC mode 1003 the same as DEC mode 1002.

hterm.VT.prototype.setDECMode_original = hterm.VT.prototype.setDECMode;
hterm.VT.prototype.setDECMode = function(code, state) {
  if (code === "1003") {
    code = "1002";
  }
  hterm.VT.prototype.setDECMode_original.call(this, code, state);
};

// Live dictation: stream dictated text to the terminal while the user speaks.
// iOS keeps revising its hypothesis, so we track what was already sent and
// correct it with DEL (0x7f) before sending the new tail.
// The dictated text accumulates in kb.caret (selection lives there), which is
// our source of truth. Can be disabled with KBConfig.streamDictation.
window.installKB_original = window.installKB;
window.installKB = function(term, element) {
  window.installKB_original(term, element);
  var kb = window._kb;
  if (!kb) {
    return;
  }

  var DEL = '\x7f';
  // How long to keep reconciling after iOS switches back from dictation,
  // since the final result may be inserted right after the input mode change.
  var GRACE_MS = 800;

  kb._dictStream = true;
  kb._dictSent = '';
  kb._dictGraceTimer = null;

  var post = function(op, args) {
    window.webkit.messageHandlers._kb.postMessage(Object.assign({op: op}, args));
  };

  var isDictating = function() {
    return kb._dictStream && (kb._lang === 'dictation' || kb._dictGraceTimer !== null);
  };

  var dictText = function() {
    return (kb.caret.textContent || '').replace(/⁠/g, '');
  };

  var sync = function() {
    var sent = Array.from(kb._dictSent);
    var cur = Array.from(dictText());
    var i = 0;
    while (i < sent.length && i < cur.length && sent[i] === cur[i]) {
      i++;
    }
    var out = DEL.repeat(sent.length - i) + cur.slice(i).join('');
    kb._dictSent = cur.join('');
    if (out) {
      post('out', {data: out});
    }
  };

  var scheduleSync = function() {
    setTimeout(function() {
      if (isDictating()) {
        sync();
      }
    }, 0);
  };

  var resetCaret = function() {
    kb.caret.innerHTML = '&#8288;';
    if (document.activeElement === kb.element) {
      var sel = window.getSelection();
      sel && sel.collapse(kb.caret);
    }
  };

  var finishDictation = function() {
    if (kb._dictGraceTimer !== null) {
      clearTimeout(kb._dictGraceTimer);
      kb._dictGraceTimer = null;
    }
    sync();
    kb._dictSent = '';
    resetCaret();
    kb._moveCaret('');
  };

  var origConfig = kb._config;
  kb._config = function(cfg) {
    origConfig.call(kb, cfg);
    kb._dictStream = !cfg || cfg.streamDictation !== false;
  };

  var origHandleLang = kb._handleLang;
  kb._handleLang = function(value) {
    var wasDictation = kb._lang === 'dictation';
    var lang = value.split(':')[0];

    if (kb._dictStream && wasDictation && lang !== 'dictation') {
      // Keep the caret content: iOS may still replace parts of it with the
      // final result. Same as original, minus clearing the caret.
      var parts = value.split(':');
      kb._lang = parts[0];
      kb._isHKB = parts[1] === 'hw';
      kb._langWithDeletes = kb._lang === 'ko-KR' || kb._lang === 'vi-VN';
      kb._down.clear();
      kb._up.clear();
      kb._mods = {Shift: new Set(), Alt: new Set(), Meta: new Set(), Control: new Set()};
      scheduleSync();
      kb._dictGraceTimer = setTimeout(finishDictation, GRACE_MS);
      return;
    }

    if (kb._dictGraceTimer !== null) {
      finishDictation();
    }
    origHandleLang.call(kb, value);
    kb._dictSent = '';
  };

  var origBeforeInput = kb._onBeforeInput;
  var onBeforeInput = function(e) {
    if (!isDictating()) {
      return origBeforeInput(e);
    }
    if (kb._lang !== 'dictation') {
      // Grace period: a single typed char or a backspace is the user typing,
      // not dictation. Commit dictation and handle it normally.
      var typed = (e.inputType === 'insertText' && (e.data || '').length <= 1) ||
                  e.inputType === 'deleteContentBackward';
      if (typed) {
        finishDictation();
        return origBeforeInput(e);
      }
    }
    // Let WebKit edit the caret content, then diff it against what we sent.
    scheduleSync();
  };

  var onInput = function(e) {
    if (!isDictating()) {
      return kb._onInput(e);
    }
    scheduleSync();
  };

  var origIME = kb._onIME;
  var onIME = function(e) {
    if (!isDictating()) {
      return origIME(e);
    }
    post('ime', {type: e.type, data: e.data || ''});
    scheduleSync();
  };

  var origKeyDown = kb._onKeyDown;
  var onKeyDown = function(e) {
    if (kb._dictGraceTimer !== null && !e.isComposing) {
      finishDictation();
    }
    return origKeyDown(e);
  };

  var el = kb.element;
  el.removeEventListener('beforeinput', kb._onBeforeInput);
  el.addEventListener('beforeinput', onBeforeInput);
  el.removeEventListener('input', kb._onInput);
  el.addEventListener('input', onInput);
  ['compositionstart', 'compositionupdate', 'compositionend'].forEach(function(type) {
    el.removeEventListener(type, kb._onIME);
    el.addEventListener(type, onIME);
  });
  el.removeEventListener('keydown', kb._onKeyDown);
  el.addEventListener('keydown', onKeyDown);
  window.removeEventListener('keydown', kb._onKeyDown);
  window.addEventListener('keydown', onKeyDown);
};
