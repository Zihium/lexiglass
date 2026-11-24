/*!
 * liquid-glass.js — Liquid Glass 运行时 v1.0
 * 复现 Backdrop 的非 CSS 部分：
 *   1) lens()   渐变折射 —— canvas 生成位移贴图，挂到 backdrop-filter: url(#lg-lens-N)
 *   2) 交互层    InteractiveHighlight 指针高光 + tanh 阻尼位移 + 4dp/高度 按压缩放
 *   3) 主题      auto / light / dark 三态，跟随系统，原生桥优先
 *
 * 用法：
 *   LiquidGlass.init();                        // 自动接管 [data-lg] / .lg / .lg-lens
 *   LiquidGlass.refresh(container);            // 动态插入节点后
 *   LiquidGlass.theme.set('auto');
 *   LiquidGlass.theme.toggle();
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    themeKey: 'lg.theme',
    themeAttr: 'data-theme',
    interactive: true,
    lens: true,
    lensMaxPx: 320,          // 位移贴图分辨率上限
    specularSelector: '[data-lg-specular]',  // 只吃指针高光、不做按压的元素（委托监听，支持动态节点）
    pressLift: 4,            // dp，对应 Backdrop 的 4.dp.toPx() / size.height
    damping: 0.05            // Backdrop 的 initialDerivative
  };

  var CFG = Object.assign({}, DEFAULTS);
  var lensSeq = 0;
  var caps = { urlBackdrop: null };
  var roots = [];

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */
  function q(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }

  var raf = global.requestAnimationFrame || function (f) { return setTimeout(f, 16); };

  /* ------------------------------------------------------------------ */
  /* 能力探测                                                            */
  /* ------------------------------------------------------------------ */
  function supportsUrlBackdrop() {
    if (caps.urlBackdrop !== null) return caps.urlBackdrop;
    var d = document.createElement('div');
    var ok = false;
    try {
      d.style.backdropFilter = 'url(#lg-probe)';
      ok = /url\(/i.test(d.style.backdropFilter || '');
      if (!ok) {
        d.style.webkitBackdropFilter = 'url(#lg-probe)';
        ok = /url\(/i.test(d.style.webkitBackdropFilter || '');
      }
    } catch (e) { ok = false; }
    caps.urlBackdrop = ok;
    return ok;
  }

  /* ------------------------------------------------------------------ */
  /* 1. 位移贴图（折射）                                                  */
  /* ------------------------------------------------------------------ */
  function sdRoundRect(px, py, w, h, r) {
    var qx = Math.abs(px - w / 2) - (w / 2 - r);
    var qy = Math.abs(py - h / 2) - (h / 2 - r);
    var ax = Math.max(qx, 0), ay = Math.max(qy, 0);
    return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
  }

  /* 生成位移贴图：边缘带内向法线 + 衰减，编码 R=(0.5+nx)*255, G=(0.5+ny)*255 */
  function buildMap(w, h, radius, opts) {
    opts = opts || {};
    var scale = 1;
    var maxSide = Math.max(w, h);
    if (maxSide > CFG.lensMaxPx) scale = CFG.lensMaxPx / maxSide;
    var mw = Math.max(16, Math.round(w * scale));
    var mh = Math.max(16, Math.round(h * scale));
    var r = Math.max(0, Math.min(radius, Math.min(w, h) / 2)) * scale;

    var cv = document.createElement('canvas');
    cv.width = mw; cv.height = mh;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(mw, mh);
    var px = img.data;

    // 边缘折射带厚度：默认短边的 10%；--lg-lens-band 可调（水滴透镜给 0.42）
    var bandRatio = opts.band || 0.10;
    var band = clamp(Math.min(mw, mh) * bandRatio, 6, Math.min(mw, mh) * 0.5);
    var power = opts.power || 2;
    var eps = 0.75;

    for (var y = 0; y < mh; y++) {
      for (var x = 0; x < mw; x++) {
        var i = (y * mw + x) * 4;
        var s = sdRoundRect(x + 0.5, y + 0.5, mw, mh, r);  // 内部为负
        var inside = -s;                                   // 距边距离

        if (inside <= 0) {                                 // 形状外：不动
          px[i] = 128; px[i + 1] = 128; px[i + 2] = 0; px[i + 3] = 255;
          continue;
        }
        if (inside >= band) {                              // 形状内：不折射
          px[i] = 128; px[i + 1] = 128; px[i + 2] = 0; px[i + 3] = 255;
          continue;
        }

        // SDF 梯度 → 外向法线；取反得内向法线
        var gx = (sdRoundRect(x + 0.5 + eps, y + 0.5, mw, mh, r) - s) / eps;
        var gy = (sdRoundRect(x + 0.5, y + 0.5 + eps, mw, mh, r) - s) / eps;
        var gl = Math.sqrt(gx * gx + gy * gy) || 1;
        var nx = -gx / gl, ny = -gy / gl;

        // 衰减：贴边最强，到 band 处为 0；power 越大越像水滴（陡边）
        var t = 1 - inside / band;
        var fall = Math.pow(t, power);

        px[i] = Math.round(128 + nx * 127 * fall);
        px[i + 1] = Math.round(128 + ny * 127 * fall);
        px[i + 2] = 0;
        px[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    try { return cv.toDataURL('image/png'); } catch (e) { return null; }
  }

  function ensureFilter(el) {
    if (!supportsUrlBackdrop()) return false;
    var cs = global.getComputedStyle(el);
    var w = el.offsetWidth || el.clientWidth;
    var h = el.offsetHeight || el.clientHeight;
    if (!w || !h) return false;

    var radius = num(cs.borderTopLeftRadius, 0);
    var lensScale = num(cs.getPropertyValue('--lg-lens-scale'), 24) || 24;
    var lensBand = num(cs.getPropertyValue('--lg-lens-band'), 0.10) || 0.10;
    var lensPower = num(cs.getPropertyValue('--lg-lens-power'), 2) || 2;
    // 模糊必须做进 SVG filter 里（feGaussianBlur）。
    // 实测：backdrop-filter 写成 url(#f) blur(Npx) 时 Chromium 只跑了 url() 那一段，
    // 后面的 blur() 被整条忽略 —— 玻璃看着「不糊、正文直接穿过」，怎么调 N 都没反应。
    var blurPx = num(cs.getPropertyValue('--lg-blur').trim().replace('px', ''), 0) || 0;
    // 注意：scale / blur 不进 key —— 它们随时可能变，只同步属性，避免反复重建贴图
    var key = w + 'x' + h + 'r' + Math.round(radius) + 'b' + lensBand + 'p' + lensPower;
    var filter = el.__lgFilter;
    // pad 要够放下模糊（3σ）与折射位移，否则边缘会被切掉
    var pad = Math.ceil(Math.max(32, Math.min(w, h) * 0.5 + blurPx * 2));

    if (!filter) {
      lensSeq += 1;
      var id = 'lg-lens-' + lensSeq;
      var mapId = id + '-map';

      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'lg-defs');
      svg.setAttribute('aria-hidden', 'true');
      // filterUnits 用 userSpaceOnUse：元素被 scale/translate 时，objectBoundingBox
      // 会让 feImage 的采样窗口跟着变换，Chromium 下会抽出镜像的重影（实测）
      svg.innerHTML =
        '<defs><filter id="' + id + '" x="' + (-pad) + '" y="' + (-pad) + '" ' +
        'width="' + (w + pad * 2) + '" height="' + (h + pad * 2) + '" ' +
        'color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse">' +
        '<feImage id="' + mapId + '" x="0" y="0" width="' + w + '" height="' + h + '" ' +
        'preserveAspectRatio="none" result="map"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="map" scale="' + 24 + '" ' +
        'xChannelSelector="R" yChannelSelector="G" result="warp"/>' +
        '<feGaussianBlur id="' + mapId + '-blur" in="warp" stdDeviation="0"/>' +
        '</filter></defs>';
      document.body.appendChild(svg);

      filter = svg.querySelector('filter');
      el.__lgFilter = filter;
      el.__lgMap = svg.getElementById(mapId);
      el.__lgSvg = svg;
    }

    var gauss = el.__lgFilter.querySelector('feGaussianBlur');
    // CSS blur(r) 的标准差 = r/2
    var sigma = (blurPx / 2).toFixed(2);

    if (el.__lgKey === key) {
      el.__lgFilter.querySelector('feDisplacementMap').setAttribute('scale', lensScale);
      if (gauss) gauss.setAttribute('stdDeviation', sigma);
      return true;
    }
    // 尺寸变了：filter 区域与 feImage 盒子一起重算
    el.__lgFilter.setAttribute('x', -pad);
    el.__lgFilter.setAttribute('y', -pad);
    el.__lgFilter.setAttribute('width', w + pad * 2);
    el.__lgFilter.setAttribute('height', h + pad * 2);
    el.__lgMap.setAttribute('width', w);
    el.__lgMap.setAttribute('height', h);
    var url = buildMap(w, h, radius, { band: lensBand, power: lensPower });
    if (!url) return false;
    el.__lgMap.setAttribute('href', url);
    el.__lgMap.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
    el.__lgFilter.querySelector('feDisplacementMap').setAttribute('scale', lensScale);
    el.__lgKey = key;

    if (gauss) gauss.setAttribute('stdDeviation', sigma);
    el.__lgFilter.setAttribute('x', -pad);
    el.__lgFilter.setAttribute('y', -pad);
    el.__lgFilter.setAttribute('width', w + pad * 2);
    el.__lgFilter.setAttribute('height', h + pad * 2);
    var sat = cs.getPropertyValue('--lg-saturate').trim() || '1.8';
    var bri = cs.getPropertyValue('--lg-brightness').trim() || '1.06';
    // 模糊已经进了 filter，这里不要再写 blur()
    var chain = 'url(#' + filter.id + ') saturate(' + sat + ') brightness(' + bri + ')';
    el.style.webkitBackdropFilter = chain;
    el.style.backdropFilter = chain;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 2. 交互层                                                           */
  /* ------------------------------------------------------------------ */
  function bindInteractive(el) {
    if (el.__lgBound) return;
    el.__lgBound = true;

    var pressH = 0, startX = 0, startY = 0, pid = null;

    function pressScale() {
      var h = el.offsetHeight || 1;
      return 1 + (CFG.pressLift / h);
    }

    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      pid = e.pointerId;
      startX = e.clientX; startY = e.clientY;
      pressH = 1;
      el.classList.add('is-pressed');
      el.style.setProperty('--lg-scale', pressScale().toFixed(4));
      if (el.setPointerCapture && pid != null) { try { el.setPointerCapture(pid); } catch (err) {} }
    }

    function onMove(e) {
      if (pressH) {
        // tanh 阻尼：Backdrop 的 translationX = maxOffset * tanh(k * dx / maxOffset)
        var w = el.offsetWidth || 1, h = el.offsetHeight || 1;
        var maxOffset = Math.min(w, h);
        var dx = e.clientX - startX, dy = e.clientY - startY;
        var k = CFG.damping;
        var tx = maxOffset * Math.tanh(k * dx / maxOffset);
        var ty = maxOffset * Math.tanh(k * dy / maxOffset);
        el.style.setProperty('--lg-tx', tx.toFixed(2) + 'px');
        el.style.setProperty('--lg-ty', ty.toFixed(2) + 'px');
      }
      specular(el, e);
    }

    function onUp() {
      pressH = 0;
      pid = null;
      el.classList.remove('is-pressed');
      el.style.setProperty('--lg-scale', '1');
      el.style.setProperty('--lg-tx', '0px');
      el.style.setProperty('--lg-ty', '0px');
    }

    el.addEventListener('pointerdown', onDown, { passive: true });
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerup', onUp, { passive: true });
    el.addEventListener('pointercancel', onUp, { passive: true });
    el.addEventListener('pointerleave', function (e) {
      onUp();
      el.style.setProperty('--lg-sx', '50%');
      el.style.setProperty('--lg-sy', '0%');
    }, { passive: true });
  }

  function specular(el, e) {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    el.style.setProperty('--lg-sx', ((e.clientX - r.left) / r.width * 100).toFixed(2) + '%');
    el.style.setProperty('--lg-sy', ((e.clientY - r.top) / r.height * 100).toFixed(2) + '%');
  }

  /* ------------------------------------------------------------------ */
  /* 3. 主题                                                             */
  /* ------------------------------------------------------------------ */
  var Theme = {
    mode: 'auto',
    listeners: [],

    bridge: function () {
      try {
        if (global.Android && typeof global.Android.getSystemTheme === 'function') return global.Android;
      } catch (e) {}
      return null;
    },

    system: function () {
      var b = this.bridge();
      if (b) {
        try {
          var v = b.getSystemTheme();
          if (v === 'dark' || v === 'light') return v;
          if (v === 'night' || v === 'yes' || v === true) return 'dark';
        } catch (e) {}
      }
      try {
        if (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      } catch (e) {}
      return 'light';
    },

    resolve: function () {
      return this.mode === 'auto' ? this.system() : this.mode;
    },

    read: function () {
      try {
        var v = localStorage.getItem(CFG.themeKey);
        if (v === 'light' || v === 'dark' || v === 'auto') this.mode = v;
      } catch (e) {}
      return this.mode;
    },

    apply: function (animate) {
      var actual = this.resolve();
      var html = document.documentElement;
      if (html.getAttribute(CFG.themeAttr) !== actual) {
        if (animate === false) html.style.transition = 'none';
        html.setAttribute(CFG.themeAttr, actual);
        if (animate === false) {
          void html.offsetWidth;
          html.style.transition = '';
        }
      }
      html.setAttribute('data-lg-theme-mode', this.mode);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', actual === 'dark' ? '#0b0b0d' : '#f7f7f8');
      this.emit(actual);
      return actual;
    },

    emit: function (actual) {
      for (var i = 0; i < this.listeners.length; i++) {
        try { this.listeners[i](actual, this.mode); } catch (e) {}
      }
      try {
        global.dispatchEvent(new CustomEvent('lg-theme', { detail: { theme: actual, mode: this.mode } }));
      } catch (e) {}
    },

    set: function (mode, opts) {
      this.mode = (mode === 'light' || mode === 'dark') ? mode : 'auto';
      try { localStorage.setItem(CFG.themeKey, this.mode); } catch (e) {}
      return this.apply(opts && opts.animate === false ? false : true);
    },

    toggle: function () {
      var order = ['auto', 'light', 'dark'];
      var i = order.indexOf(this.mode);
      return this.set(order[(i + 1) % order.length]);
    },

    next: function () { return this.toggle(); },

    onChange: function (fn) {
      if (typeof fn === 'function') this.listeners.push(fn);
      return function () {
        var i = Theme.listeners.indexOf(fn);
        if (i >= 0) Theme.listeners.splice(i, 1);
      };
    },

    attach: function () {
      var self = this;
      this.read();
      this.apply(false);

      try {
        var mq = global.matchMedia('(prefers-color-scheme: dark)');
        var handler = function () { if (self.mode === 'auto') self.apply(true); };
        if (mq.addEventListener) mq.addEventListener('change', handler);
        else if (mq.addListener) mq.addListener(handler);
      } catch (e) {}

      // 原生侧 onConfigurationChanged 推过来的系统主题
      global.__lgSystemTheme = function (mode) {
        var sys = (mode === 'dark' || mode === 'night') ? 'dark' : 'light';
        global.__lgSys = sys;
        global.__lgSysNative = true;
        if (self.mode === 'auto') self.apply(true);
        else self.emit(self.resolve());
      };

      // 老版本存的是 light/dark 二态：一次性迁移到 auto
      try {
        if (!localStorage.getItem(CFG.themeKey + '.migrated')) {
          localStorage.setItem(CFG.themeKey + '.migrated', '1');
          if (!localStorage.getItem(CFG.themeKey)) this.set('auto', { animate: false });
        }
      } catch (e) {}
    }
  };

  // 原生桥优先于 matchMedia
  var _sysOrig = Theme.system;
  Theme.system = function () {
    if (global.__lgSysNative && (global.__lgSys === 'dark' || global.__lgSys === 'light')) {
      return global.__lgSys;
    }
    return _sysOrig.call(this);
  };

  /* ------------------------------------------------------------------ */
  /* 4. 装配                                                             */
  /* ------------------------------------------------------------------ */
  function mount(root, cfg) {
    var scope = root || document;

    q('.lg, [data-lg]', scope).forEach(function (el) {
      if (cfg.interactive && (el.hasAttribute('data-lg-interactive') || el.tagName === 'BUTTON' ||
          el.getAttribute('role') === 'button' || el.classList.contains('lg--capsule') ||
          el.classList.contains('lg--dock') || el.hasAttribute('data-lg-interactive'))) {
        bindInteractive(el);
      } else if (cfg.interactive && el.hasAttribute('data-lg-press')) {
        bindInteractive(el);
      }
      if (cfg.lens && (el.classList.contains('lg-lens') || el.hasAttribute('data-lg-lens'))) {
        ensureFilter(el);
      }
    });

    if (cfg.lens) {
      var ro = ('ResizeObserver' in global) ? new ResizeObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.target.__lgFilter) return;
          var w = en.target.offsetWidth, h = en.target.offsetHeight;
          var key = w + 'x' + h + 'r' + Math.round(num(global.getComputedStyle(en.target).borderTopLeftRadius, 0));
          if (en.target.__lgKey !== key) ensureFilter(en.target);
        });
      }) : null;
      q('.lg-lens, [data-lg-lens]', scope).forEach(function (el) {
        // 裸 .lg-lens（没有 .lg / [data-lg]）也要生成折射贴图
        if (!el.__lgFilter) ensureFilter(el);
        if (ro && !el.__lgRO) { el.__lgRO = ro; ro.observe(el); }
      });
    }

    roots.push(scope);
  }

  var LiquidGlass = {
    version: '1.0.0',

    init: function (opts) {
      CFG = Object.assign({}, DEFAULTS, opts || {});
      Theme.attach();
      mount(document, CFG);

      // 高光委托：动态渲染的列表项无需逐个绑定
      if (CFG.specularSelector && !document.__lgSpecBound) {
        document.__lgSpecBound = true;
        // rAF 合并：滚动时 pointermove 一帧可能来好几次，都只写一次 CSS 变量，
        // 避免每 move 一次 getBoundingClientRect + 强制 paint（列表滚动卡顿的主因）
        var specEvt = null, specRaf = 0;
        document.addEventListener('pointermove', function (e) {
          specEvt = e;
          if (specRaf) return;
          specRaf = raf(function () {
            specRaf = 0;
            var ev = specEvt;
            specEvt = null;
            if (!ev) return;
            var t = ev.target;
            if (!t || !t.closest) return;
            var el = t.closest(CFG.specularSelector);
            if (el && el.getClientRects().length) specular(el, ev);
          });
        }, { passive: true });
      }

      // 字体/尺寸变化后重算贴图
      var t = null;
      global.addEventListener('resize', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          q('.lg-lens, [data-lg-lens]').forEach(function (el) {
            if (el.__lgFilter) ensureFilter(el);
          });
        }, 160);
      }, { passive: true });

      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && Theme.mode === 'auto') Theme.apply(true);
      });

      return this;
    },

    refresh: function (root) { mount(root || document, CFG); return this; },

    /* 给普通元素补玻璃能力（不写类名也能用） */
    apply: function (el, variant) {
      var one = typeof el === 'string' ? document.querySelector(el) : el;
      if (!one) return null;
      one.classList.add('lg');
      if (variant) one.classList.add('lg--' + variant);
      mount(one.parentNode || document, CFG);
      return one;
    },

    theme: Theme,

    _buildMap: buildMap,
    _supportsUrlBackdrop: supportsUrlBackdrop
  };

  global.LiquidGlass = LiquidGlass;

  // 无显式 init 时自动装配
  if (!global.__lgManualInit) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { LiquidGlass.init(); });
    } else {
      LiquidGlass.init();
    }
  }
})(typeof window !== 'undefined' ? window : this);
