/*!
 * liquid-glass-dock.js — v2.0
 * 1:1 port of LiquidBottomTabs from https://github.com/Kyant0/AndroidLiquidGlass (kmp)
 *
 * 与源码对照：
 *   DampedDragAnimation  spring 参数（Compose spring(dampingRatio, stiffness)）
 *     value          spring(1f, 1000f)     -> k = 1000, c = 2*sqrt(1000)
 *     pressProgress  spring(1f, 1000f)     -> k = 1000, c = 2*sqrt(1000)
 *     scaleX         spring(0.6f, 250f)    -> k = 250,  c = 2*0.6*sqrt(250)
 *     scaleY         spring(0.7f, 250f)    -> k = 250,  c = 2*0.7*sqrt(250)
 *     velocity       spring(0.5f, 300f)    -> k = 300,  c = 2*0.5*sqrt(300)
 *   松手回中 offsetAnimation spring(1f, 300f) -> k = 300, c = 2*sqrt(300)
 *   pressedScale = 78f / 56f ≈ 1.3929
 *   拖动位移 -> panelOffset = 4dp * sign(fraction) * EaseOut(|fraction|)
 *   EaseOut = CubicBezierEasing(0, 0, .58, 1)
 *
 * 用法：
 *   var dock = new GlassDock(document.getElementById('bottom-nav'), {
 *     panes: '.tab-pane',
 *     onChange: function (index, id) {}
 *   });
 *   dock.select(2);
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- 工具 */

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function clamp1(v) { return clamp(v, -1, 1); }
  function sign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }

  /* Compose CubicBezierEasing(0, 0, .58, 1) 的求值 */
  function bezierY(x, x1, y1, x2, y2) {
    var t = x;
    for (var i = 0; i < 8; i++) {
      var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
      var fx = ((ax * t + bx) * t + cx) * t - x;
      var dfx = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(fx) < 1e-6 || Math.abs(dfx) < 1e-6) break;
      t -= fx / dfx;
      t = clamp(t, 0, 1);
    }
    var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    return ((ay * t + by) * t + cy) * t;
  }
  function easeOut(x) { return bezierY(clamp(x, 0, 1), 0, 0, 0.58, 1); }

  /* 单自由度弹簧（Compose SpringForce：mass = 1） */
  function Spring(value, k, c) {
    this.v = value;
    this.target = value;
    this.vel = 0;
    this.k = k;
    this.c = c;
  }
  Spring.prototype.step = function (dt) {
    var sub = 4;
    var h = clamp(dt, 0, 1 / 30) / sub;
    for (var i = 0; i < sub; i++) {
      var a = -this.k * (this.v - this.target) - this.c * this.vel;
      this.vel += a * h;
      this.v += this.vel * h;
    }
    if (Math.abs(this.v - this.target) < 1e-4 && Math.abs(this.vel) < 1e-2) {
      this.v = this.target;
      this.vel = 0;
    }
  };
  Spring.prototype.snap = function (value) {
    this.v = value;
    this.target = value;
    this.vel = 0;
  };
  Spring.prototype.settled = function () {
    return this.v === this.target && this.vel === 0;
  };

  var SQRT = Math.sqrt;
  var SPEC = {
    value: [1000, 2 * SQRT(1000)],
    press: [1000, 2 * SQRT(1000)],
    scaleX: [250, 2 * 0.6 * SQRT(250)],
    scaleY: [250, 2 * 0.7 * SQRT(250)],
    velocity: [300, 2 * 0.5 * SQRT(300)],
    panel: [300, 2 * SQRT(300)]
  };

  var PRESSED_SCALE = 78 / 56;   // 1.3928571
  var PANEL_MAX = 4;             // 4dp

  /* ---------------------------------------------------------------- 构造 */

  function GlassDock(nav, options) {
    if (!nav) throw new Error('GlassDock: nav element required');

    var o = options || {};
    this.nav = nav;
    this.o = {
      panes: o.panes || null,
      activeClass: o.activeClass || 'active',
      scrollMemory: !!o.scrollMemory,
      onChange: typeof o.onChange === 'function' ? o.onChange : null,
      haptics: o.haptics !== false
    };

    this.buttons = Array.prototype.slice.call(nav.querySelectorAll('.tab-btn'));
    if (!this.buttons.length) return;
    this.pill = nav.querySelector('.nav-pill');
    this.count = this.buttons.length;

    nav.style.setProperty('--lg-count', String(this.count));

    this.value = new Spring(0, SPEC.value[0], SPEC.value[1]);
    this.press = new Spring(0, SPEC.press[0], SPEC.press[1]);
    this.sx = new Spring(1, SPEC.scaleX[0], SPEC.scaleX[1]);
    this.sy = new Spring(1, SPEC.scaleY[0], SPEC.scaleY[1]);
    this.vel = new Spring(0, SPEC.velocity[0], SPEC.velocity[1]);
    this.panel = new Spring(0, SPEC.panel[0], SPEC.panel[1]);

    this.selected = Math.max(0, this._indexOfActive());
    this.value.snap(this.selected);

    this.panelAcc = 0;
    this.dragging = false;
    this.pendingRelease = false;
    this.pointerId = null;
    this.startX = 0;
    this.startY = 0;
    this.lastX = 0;
    this.downIndex = -1;
    this.moved = false;
    this.raf = 0;
    this.lastTs = 0;
    this._destroyed = false;
    this._suppressClickUntil = 0;
    this._scrollMemo = {};
    this._tickBound = this._tick.bind(this);
    this._reduced = global.matchMedia
      ? global.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false, addEventListener: function () {} };

    this.W = 0;
    this.tabW = 1;

    this._panes = this.o.panes
      ? Array.prototype.slice.call(document.querySelectorAll(this.o.panes))
      : [];

    this._measure();
    this._syncAria();
    this._render();
    this._syncLens();
    this._bind();

    nav.__glassDock = this;
  }

  /* ---------------------------------------------------------------- 测量 */

  GlassDock.prototype._measure = function () {
    var W = this.nav.getBoundingClientRect().width || this.nav.offsetWidth || 0;
    if (!W) return;
    this.W = W;
    // 源码：tabWidth = (constraints.maxWidth - 8.dp) / tabsCount
    this.tabW = (W - 8) / this.count;
    this.nav.style.setProperty('--lg-count', String(this.count));
    this._render();
  };

  GlassDock.prototype._indexOfActive = function () {
    for (var i = 0; i < this.buttons.length; i++) {
      if (this.buttons[i].classList.contains(this.o.activeClass)) return i;
    }
    return 0;
  };

  /* ---------------------------------------------------------------- 渲染 */

  GlassDock.prototype._render = function () {
    var nav = this.nav;

    var p = clamp(this.press.v, 0, 1.2);
    var W = this.W || 1;

    // 容器：lerp(1, 1 + 16dp / size.width, pressProgress)
    nav.style.setProperty('--lg-dock-scale', String(1 + (16 / W) * p));
    nav.style.setProperty('--lg-p', String(p));
    // 内容：lerp(1, 1.2, pressProgress)
    nav.style.setProperty('--lg-tab-scale', String(1 + 0.2 * p));

    // 指示器位置（单位 px，left 已含 4dp）
    nav.style.setProperty('--lg-x', (this.value.v * this.tabW).toFixed(2) + 'px');

    // 指示器形变：velocity / 10 做横向拉伸
    var v = this.vel.v / 10;
    var sx = this.sx.v / (1 - clamp(v * 0.75, -0.2, 0.2));
    var sy = this.sy.v * (1 - clamp(v * 0.25, -0.2, 0.2));
    nav.style.setProperty('--lg-sx', String(sx));
    nav.style.setProperty('--lg-sy', String(sy));

    // panelOffset = 4dp * sign(f) * EaseOut(|f|)
    var f = clamp1(this.panelAcc / (W || 1));
    var off = PANEL_MAX * sign(f) * easeOut(Math.abs(f));
    nav.style.setProperty('--lg-panel', off.toFixed(2) + 'px');

    // 按压高光中心 = 指示器中心
    nav.style.setProperty('--lg-hl-x', (4 + (this.value.v + 0.5) * this.tabW).toFixed(2) + 'px');

    // 选中度：拖动时颜色在 ink 与 accent 之间连续插值（源码 LocalContentColor 的等效）
    var cache = this._selCache || (this._selCache = []);
    for (var i = 0; i < this.buttons.length; i++) {
      var sel = Math.max(0, 1 - Math.abs(i - this.value.v));
      if (cache[i] === undefined || Math.abs(cache[i] - sel) > 0.004) {
        cache[i] = sel;
        this.buttons[i].style.setProperty('--sel', sel.toFixed(3));
      }
    }

    this._syncLens();
  };

  /* 指示器透镜强度：直接改 feDisplacementMap.scale，不重建贴图
     源码 lens(10.dp * p, 14.dp * p)：p=0 时半径 0，p=1 时位移约 14px
     这里留 3px 基线，让常态也有一点点玻璃感（上游是纯平的 Black@10%） */
  GlassDock.prototype._syncLens = function () {
    var pill = this.pill;
    if (!pill) return;
    if (!pill.__lgFilter) {
      if (global.LiquidGlass && global.LiquidGlass.refresh && !this._lensTried) {
        this._lensTried = true;
        global.LiquidGlass.refresh(pill.parentNode || document);
      }
      if (!pill.__lgFilter) return;
    }
    var dm = pill.__lgFilter.querySelector('feDisplacementMap');
    if (!dm) return;
    var target = 3 + 10 * clamp(this.press.v, 0, 1);
    if (this._lastLensScale !== undefined && Math.abs(this._lastLensScale - target) < 0.04) return;
    this._lastLensScale = target;
    dm.setAttribute('scale', target.toFixed(2));
  };

  /* ---------------------------------------------------------------- 循环 */

  GlassDock.prototype._tick = function (ts) {
    if (this._destroyed) return;
    var dt = this.lastTs ? (ts - this.lastTs) / 1000 : 1 / 60;
    this.lastTs = ts;

    this.value.step(dt);
    this.press.step(dt);
    this.sx.step(dt);
    this.sy.step(dt);
    this.vel.step(dt);
    this.panel.step(dt);

    // release：等 value 收敛到 target 的 2.5% 内再回弹（源码 release() 的 awaitFrame + threshold）
    if (this.pendingRelease) {
      var threshold = ((this.count - 1) || 1) * 0.025;
      if (Math.abs(this.value.v - this.value.target) < threshold) {
        this.pendingRelease = false;
        this._rebound();
      }
    }

    // 松手后 panelAcc 归零，避免下次拖动突跳
    if (!this.dragging && this.panelAcc !== 0 && this.panel.settled()) this.panelAcc = 0;

    this._render();

    var busy = !(this.value.settled() && this.press.settled() && this.sx.settled() &&
      this.sy.settled() && this.vel.settled() && this.panel.settled()) ||
      this.pendingRelease || this.dragging;

    if (busy) {
      this.raf = global.requestAnimationFrame(this._tickBound);
    } else {
      this.raf = 0;
      this.lastTs = 0;
      if (this.press.v <= 0.0005) this.nav.classList.remove('is-pressing');
      this._render();
    }
  };

  GlassDock.prototype._start = function () {
    if (this.raf) return;
    this.lastTs = 0;
    this.raf = global.requestAnimationFrame(this._tickBound);
  };

  /* ---------------------------------------------------------------- 按压 */

  GlassDock.prototype._press = function () {
    this.vel.snap(0);
    this.press.target = 1;
    this.sx.target = PRESSED_SCALE;
    this.sy.target = PRESSED_SCALE;
    this.pendingRelease = false;
    this.nav.classList.add('is-pressing');
    this._start();
    if (this.o.haptics && global.navigator && global.navigator.vibrate && !this._reduced.matches) {
      try { global.navigator.vibrate(8); } catch (e) { /* 无振动马达 */ }
    }
  };

  GlassDock.prototype._rebound = function () {
    this.press.target = 0;
    this.sx.target = 1;
    this.sy.target = 1;
    this._start();
  };

  GlassDock.prototype._release = function () {
    this.pendingRelease = true;
    this._start();
  };

  /* ---------------------------------------------------------------- 选中 */

  GlassDock.prototype.animateToValue = function (index) {
    var target = clamp(Number(index) || 0, 0, this.count - 1);
    this.press.target = 1;
    this.sx.target = PRESSED_SCALE;
    this.sy.target = PRESSED_SCALE;
    this.nav.classList.add('is-pressing');
    this.value.target = target;
    this.vel.target = 0;
    this._release();
    this._start();
    return this;
  };

  GlassDock.prototype.select = function (index) {
    var target = clamp(Number(index) || 0, 0, this.count - 1);
    this.animateToValue(target);
    this._commit(target, false);
    return this;
  };

  GlassDock.prototype.setSelected = function (index) {
    var target = clamp(Number(index) || 0, 0, this.count - 1);
    this.selected = target;
    this.value.snap(target);
    this._syncAria();
    this._render();
    return this;
  };

  GlassDock.prototype._commit = function (index, silent) {
    if (index !== this.selected) this._rememberScroll();
    var id = this.buttons[index].getAttribute('data-tab');
    this.selected = index;
    this.buttons.forEach(function (b, i) {
      b.classList.toggle(this.o.activeClass, i === index);
    }, this);
    this._switchPane(index);
    this._syncAria();
    if (this.o.scrollMemory && index === this.selected) this._restoreScroll(index);
    if (!silent && this.o.onChange) this.o.onChange(index, id);
    return id;
  };

  GlassDock.prototype._syncAria = function () {
    this.nav.setAttribute('role', 'tablist');
    this.buttons.forEach(function (b, i) {
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', i === this.selected ? 'true' : 'false');
      b.setAttribute('tabindex', i === this.selected ? '0' : '-1');
    }, this);
  };

  /* ---------------------------------------------------------------- 面板 */

  GlassDock.prototype._paneFor = function (button, index) {
    if (!this._panes.length) return null;
    var id = button.getAttribute('data-tab');
    var byAttr = button.getAttribute('data-pane');
    var found = null;
    if (byAttr) {
      found = this._panes.filter(function (p) { return p.getAttribute('data-pane') === byAttr; })[0];
    }
    if (!found && id) {
      found = this._panes.filter(function (p) { return p.id === 'tab-' + id; })[0];
    }
    if (!found) found = this._panes[index] || null;
    return found;
  };

  GlassDock.prototype._switchPane = function (index) {
    if (!this._panes.length) return;
    var target = this._paneFor(this.buttons[index], index);
    this._panes.forEach(function (p) {
      p.classList.toggle(this.o.activeClass, p === target);
    }, this);
  };

  GlassDock.prototype._rememberScroll = function () {
    if (!this.o.scrollMemory) return;
    var pane = this._panes[this.selected];
    if (pane) this._scrollMemo[this.selected] = pane.scrollTop || 0;
  };

  GlassDock.prototype._restoreScroll = function (index) {
    if (!this.o.scrollMemory) return;
    var pane = this._panes[index];
    if (pane && this._scrollMemo[index]) pane.scrollTop = this._scrollMemo[index];
  };

  /* ---------------------------------------------------------------- 事件 */

  GlassDock.prototype._bind = function () {
    var self = this;
    var nav = this.nav;
    var listeners = [];
    this._listeners = listeners;

    function on(target, type, handler, opts) {
      target.addEventListener(type, handler, opts);
      listeners.push(function () { target.removeEventListener(type, handler, opts); });
    }

    function tabIndexFromEvent(e) {
      var el = e.target && e.target.closest ? e.target.closest('.tab-btn') : null;
      if (!el || !nav.contains(el)) return -1;
      return self.buttons.indexOf(el);
    }

    function trace(tag, e) {
      if (!global.__lgGestureLog) return;
      global.__lgGestureLog.push(tag + '|' + Math.round(e.clientX || 0) + '|' + Math.round(e.clientY || 0) +
        '|' + (e.pointerType || '') + '|' + ((e.target && e.target.className) || '').toString().slice(0, 16));
      if (global.__lgGestureLog.length > 200) global.__lgGestureLog.shift();
    }

    on(nav, 'pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      trace('down', e);
      self.pointerId = e.pointerId;
      self.startX = e.clientX;
      self.startY = e.clientY;
      self.lastX = e.clientX;
      self.downIndex = tabIndexFromEvent(e);
      self.moved = false;
      self.dragging = false;
      self.panelAcc = 0;
      self.panel.snap(0);
      try { nav.setPointerCapture(e.pointerId); } catch (err) { /* 老 WebView */ }
      self._press();
    }, { passive: true });

    on(nav, 'pointermove', function (e) {
      if (self.pointerId === null || e.pointerId !== self.pointerId) return;
      var dxTotal = e.clientX - self.startX;
      var dyTotal = e.clientY - self.startY;

      if (!self.moved) {
        if (Math.abs(dxTotal) < 5 && Math.abs(dyTotal) < 5) { trace('move-tiny', e); return; }
        if (Math.abs(dyTotal) > Math.abs(dxTotal) && Math.abs(dyTotal) > 10) {
          self._endPointer(false);
          return;
        }
        self.moved = true;
        self.dragging = true;
      }

      var dx = e.clientX - self.lastX;
      self.lastX = e.clientX;

      // value.target += dragAmount.x / tabWidth
      self.value.target = clamp(self.value.target + dx / self.tabW, 0, self.count - 1);
      self.panelAcc += dx;
      // 速度跟踪（驱动指示器拉伸）
      self.vel.target = clamp((dx / self.tabW) * 30, -1.2, 1.2);
      self._start();
    }, { passive: true });

    function endHandler(e) {
      trace('up', e);
      if (self.pointerId === null) { trace('up-ignored', e); return; }
      if (e && e.pointerId !== undefined && e.pointerId !== self.pointerId) return;
      self._endPointer(true);
    }
    on(nav, 'pointerup', endHandler);
    on(nav, 'pointercancel', endHandler);
    on(nav, 'lostpointercapture', endHandler);

    on(global, 'blur', function () {
      if (self.pointerId !== null) self._endPointer(true);
    });

    // 真实点击（键盘 / 辅助技术 / 合成事件）
    on(nav, 'click', function (e) {
      if (Date.now() < self._suppressClickUntil) return;
      var idx = tabIndexFromEvent(e);
      if (idx < 0) return;
      e.preventDefault();
      self.select(idx);
    });

    on(nav, 'keydown', function (e) {
      var idx = self.selected;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var next = clamp(idx + (e.key === 'ArrowRight' ? 1 : -1), 0, self.count - 1);
        self.select(next);
        self.buttons[next].focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        var to = e.key === 'Home' ? 0 : self.count - 1;
        self.select(to);
        self.buttons[to].focus();
      }
    });

    if (global.ResizeObserver) {
      var ro = new ResizeObserver(function () { self._measure(); });
      ro.observe(nav);
      listeners.push(function () { ro.disconnect(); });
    } else {
      on(global, 'resize', function () { self._measure(); });
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { self._measure(); });
    }
  };

  GlassDock.prototype._endPointer = function (commit) {
    var idx = this.downIndex;
    var wasDrag = this.dragging;

    this.pointerId = null;
    this.dragging = false;
    this.downIndex = -1;

    if (commit) {
      this._suppressClickUntil = Date.now() + 400;

      if (!wasDrag && idx >= 0) {
        this.value.target = idx;
        this._commit(idx);
      } else {
        var target = clamp(Math.round(this.value.target), 0, this.count - 1);
        this.value.target = target;
        if (target !== this.selected) this._commit(target);
        else this._syncAria();
        this.vel.target = 0;
      }
      this.panelAcc = 0;
      this.panel.target = 0;
      this._release();
    } else {
      this.pendingRelease = false;
      this.panelAcc = 0;
      this.panel.snap(0);
      this._rebound();
    }
  };

  /* ---------------------------------------------------------------- 公开 */

  GlassDock.prototype.refresh = function () {
    this._measure();
    return this;
  };

  GlassDock.prototype.destroy = function () {
    this._destroyed = true;
    if (this.raf) global.cancelAnimationFrame(this.raf);
    this.raf = 0;
    (this._listeners || []).forEach(function (off) { off(); });
    this._listeners = [];
    if (this.nav.__glassDock === this) this.nav.__glassDock = null;
    return this;
  };

  /* ---------------------------------------------------------------- 自动挂载 */

  function autoMount() {
    var navs = document.querySelectorAll('.nav-tabs#bottom-nav, .nav-tabs[data-glass-dock]');
    return Array.prototype.map.call(navs, function (nav) {
      if (nav.__glassDock) return nav.__glassDock;
      var dock = new GlassDock(nav, {
        panes: nav.getAttribute('data-panes') || '.tab-pane',
        onChange: function (index, id) {
          nav.dispatchEvent(new CustomEvent('dock:change', {
            bubbles: true,
            detail: { index: index, id: id }
          }));
        }
      });
      return dock;
    });
  }

  global.GlassDock = GlassDock;
  global.GlassDock.autoMount = autoMount;
  global.GlassDock.easeOut = easeOut;

  // 不自动挂载：宿主页面通常要自己传 onChange。需要自动时调用 GlassDock.autoMount()。
})(typeof window !== 'undefined' ? window : this);
