/**
 * Kolibri support chat — the loader a site embeds.
 *
 *   <script>window.kolibriChat = { widget: '<id>', token: () => fetch('/my-token').then((r) => r.text()) };</script>
 *   <script src="https://kolibri.example.com/widget.js" async></script>
 *
 * It draws a button and nothing else. No request leaves the page, no cookie is
 * set and no frame exists until somebody clicks: then the chat opens in an
 * iframe served by Kolibri, which is where everything else happens. The
 * button lives in a shadow root, so the site's CSS cannot reach it and its
 * CSS cannot reach the site.
 *
 * `widget` and `token` are read on the click; the button's looks when it is
 * drawn, so the config tag goes first. Options:
 *
 *   widget    the widget's id (required)
 *   token     a token, or a function returning one or a promise of one —
 *             signed widgets only; asked for on the first click, never before
 *   color     the button's colour, '#rrggbb' (the window takes the widget's own)
 *   position  'right' (default) or 'left'
 *   launcher  false to draw no button; open it with window.KolibriChat.open()
 *
 * Plain ES5 on purpose: it runs on other people's pages, in whatever browser
 * their visitors have, and is served as it is written.
 */
(function () {
  'use strict';
  if (window.KolibriChat) return;

  var script = document.currentScript;
  var origin = script && script.src ? new URL(script.src, window.location.href).origin : window.location.origin;
  var frame = null;
  var panel = null;
  var badge = null;
  var opened = false;

  function config() {
    return window.kolibriChat || {};
  }

  function post(message) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, origin);
  }

  function giveToken() {
    var source = config().token;
    var answer;
    try {
      answer = typeof source === 'function' ? source() : source;
    } catch (error) {
      answer = null;
    }
    Promise.resolve(answer).then(
      function (token) { post({ type: 'kolibri-chat:token', token: typeof token === 'string' ? token.trim() : null }); },
      function () { post({ type: 'kolibri-chat:token', token: null }); }
    );
  }

  function setBadge(count) {
    if (!badge) return;
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.hidden = !count;
  }

  function open() {
    var widget = config().widget;
    if (!widget || !panel) return;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.src = origin + '/w/' + encodeURIComponent(widget);
      frame.title = 'Chat';
      frame.allow = 'clipboard-write';
      panel.appendChild(frame);
    }
    opened = true;
    panel.hidden = false;
    post({ type: 'kolibri-chat:visibility', open: true });
  }

  function close() {
    if (!panel) return;
    opened = false;
    panel.hidden = true;
    post({ type: 'kolibri-chat:visibility', open: false });
  }

  window.addEventListener('message', function (event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
    var data = event.data || {};
    if (data.type === 'kolibri-chat:token-request') giveToken();
    else if (data.type === 'kolibri-chat:close') close();
    else if (data.type === 'kolibri-chat:unread') setBadge(opened ? 0 : Number(data.count) || 0);
  });

  function mount() {
    var options = config();
    var left = options.position === 'left';
    var color = /^#[0-9a-f]{6}$/i.test(options.color || '') ? options.color : '#5b5bd6';
    // The glyph in black or white, whichever stands out more — the same choice
    // the window makes, so a pale site colour does not hide the button's icon.
    var light = 0.05;
    [1, 3, 5].forEach(function (at, i) {
      var c = parseInt(color.slice(at, at + 2), 16) / 255;
      light += [0.2126, 0.7152, 0.0722][i] * (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    });
    var ink = light / 0.05 > 1.05 / light ? '#000' : '#fff';
    var host = document.createElement('div');
    host.setAttribute('data-kolibri-chat', '');
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var side = left ? 'left' : 'right';
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.launcher{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000;width:56px;height:56px;border:0;border-radius:50%;' +
      'background:' + color + ';color:' + ink + ';cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center}' +
      '.launcher:focus-visible{outline:3px solid ' + color + ';outline-offset:3px}' +
      '.badge{position:absolute;top:-2px;' + (left ? 'left' : 'right') + ':-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;' +
      'background:#e5484d;color:#fff;font:600 11px/20px system-ui,sans-serif;text-align:center;box-sizing:border-box}' +
      '.panel{position:fixed;bottom:88px;' + side + ':20px;z-index:2147483000;width:380px;height:600px;max-height:calc(100vh - 108px);' +
      'border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);background:#fff}' +
      '.panel[hidden]{display:none}' +
      'iframe{border:0;width:100%;height:100%;display:block}' +
      '@media (max-width:480px){.panel{inset:0;width:auto;height:auto;max-height:none;border-radius:0}}' +
      '</style>' +
      '<div class="panel" hidden></div>' +
      '<button class="launcher" type="button" aria-label="Chat">' +
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>' +
      '<span class="badge" hidden></span></button>';
    panel = root.querySelector('.panel');
    badge = root.querySelector('.badge');
    var launcher = root.querySelector('.launcher');
    if (options.launcher === false) launcher.style.display = 'none';
    launcher.addEventListener('click', function () {
      if (opened) close();
      else open();
    });
    document.body.appendChild(host);
  }

  window.KolibriChat = {
    open: open,
    close: close,
    toggle: function () { if (opened) close(); else open(); },
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
