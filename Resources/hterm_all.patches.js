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

// Live dictation: let iOS dictation stream text to the terminal while the
// user speaks.
// iOS inserts its first hypothesis and then replaces it in place as it
// refines it. That only works if the inserted text is still in the document,
// so instead of cancelling inserts we keep them in kb.caret, which mirrors
// what was sent since the last other output. When iOS rewrites the mirror,
// we send DEL (0x7f) back to the first changed char and then the new tail.
// Any other output (keys, IME commit) or state reset clears the mirror.
// Can be disabled with KBConfig.streamDictation.
window.installKB_original = window.installKB;
window.installKB = function(term, element) {
  window.installKB_original(term, element);
  var kb = window._kb;
  if (!kb) {
    return;
  }

  var DEL = '\x7f';

  kb._dictStream = true;
  kb._mirrorSent = '';

  var post = function(op, args) {
    window.webkit.messageHandlers._kb.postMessage(Object.assign({op: op}, args));
  };

  var mirrorText = function() {
    return (kb.caret.textContent || '').replace(/\u2060/g, '');
  };

  var sync = function() {
    var sent = Array.from(kb._mirrorSent);
    var cur = Array.from(mirrorText());
    var i = 0;
    while (i < sent.length && i < cur.length && sent[i] === cur[i]) {
      i++;
    }
    var out = DEL.repeat(sent.length - i) + cur.slice(i).join('');
    kb._mirrorSent = cur.join('');
    if (out) {
      post('out', {data: out});
    }
    fixSelection();
  };

  // iOS writes its final result as a burst of inserts after selecting the
  // previous hypothesis; debounce so we only diff the settled text.
  var syncTimer = null;
  var scheduleSync = function() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function() {
      syncTimer = null;
      sync();
    }, 50);
  };
  var flushSync = function() {
    if (syncTimer !== null) {
      clearTimeout(syncTimer);
      syncTimer = null;
      sync();
    }
  };

  var mirrorActive = function(e) {
    return kb._dictStream && !e.isComposing && !kb._langWithDeletes;
  };

  // _output and _stateReset clear the caret; the mirror starts over.
  var origOutput = kb._output;
  kb._output = function(data) {
    flushSync();
    kb._mirrorSent = '';
    return origOutput(data);
  };
  var origStateReset = kb._stateReset;
  kb._stateReset = function() {
    flushSync();
    kb._mirrorSent = '';
    return origStateReset();
  };

  var origConfig = kb._config;
  kb._config = function(cfg) {
    origConfig.call(kb, cfg);
    kb._dictStream = !cfg || cfg.streamDictation !== false;
  };

  var origBeforeInput = kb._onBeforeInput;
  var onBeforeInput = function(e) {
    if (!mirrorActive(e)) {
      return origBeforeInput(e);
    }
    switch (e.inputType) {
      case 'insertText':
      case 'insertReplacementText':
        break;
      case 'deleteContentBackward':
        if (kb._mirrorSent) {
          break;
        }
        return origBeforeInput(e);
      default:
        return origBeforeInput(e);
    }
    // Let WebKit edit the mirror, then diff it against what we sent.
    kb._moveCaret('');
    scheduleSync();
  };

  var onInput = function(e) {
    if (!mirrorActive(e)) {
      return kb._onInput(e);
    }
    scheduleSync();
  };

  // Keep the selection right after the mirrored text. iOS dictation checks
  // the text before the selection to replace its previous hypothesis; if
  // something collapses the selection to the start of the caret, it gives up
  // streaming and inserts the final text there instead.
  var mirrorEnd = function() {
    var walker = document.createTreeWalker(kb.caret, NodeFilter.SHOW_TEXT);
    var last = null;
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var idx = n.data.indexOf('\u2060');
      if (idx >= 0) {
        return {node: n, offset: idx};
      }
      last = n;
    }
    return last ? {node: last, offset: last.data.length} : null;
  };

  var fixSelection = function() {
    if (!kb._mirrorSent) {
      return;
    }
    var sel = window.getSelection();
    var end = mirrorEnd();
    // A range is iOS selecting its hypothesis to replace it; leave it alone.
    if (!sel || !end || !sel.isCollapsed) {
      return;
    }
    if (sel.anchorNode === end.node && sel.anchorOffset === end.offset) {
      return;
    }
    sel.collapse(end.node, end.offset);
  };

  document.addEventListener('selectionchange', fixSelection);

  var origFocus = kb.focus.bind(kb);
  kb.focus = function(value) {
    origFocus(value);
    if (value) {
      fixSelection();
    }
  };

  var el = kb.element;
  el.removeEventListener('beforeinput', kb._onBeforeInput);
  el.addEventListener('beforeinput', onBeforeInput);
  el.removeEventListener('input', kb._onInput);
  el.addEventListener('input', onInput);
};
