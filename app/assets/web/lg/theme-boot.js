/*!
 * theme-boot.js — 防主题闪白（FOUC）
 * 必须放在 <head> 里、CSS 之前，同步执行。体积 <1KB，不要改成 defer。
 */
(function () {
  'use strict';
  var KEY = 'lg.theme';
  var mode = 'auto';
  try {
    var v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') mode = v;
  } catch (e) {}

  var sys = 'light';
  var fromNative = false;
  try {
    if (window.Android && typeof window.Android.getSystemTheme === 'function') {
      var n = window.Android.getSystemTheme();
      if (n === 'dark' || n === 'night') sys = 'dark';
      fromNative = true;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      sys = 'dark';
    }
  } catch (e) {}

  var actual = mode === 'auto' ? sys : mode;
  // 仅当值来自原生桥时缓存，否则每次都要重新读 matchMedia
  if (fromNative) { window.__lgSys = sys; window.__lgSysNative = true; }

  var html = document.documentElement;
  html.setAttribute('data-theme', actual);
  html.setAttribute('data-lg-theme-mode', mode);

  var meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', actual === 'dark' ? '#0b0b0d' : '#f7f7f8');
})();
