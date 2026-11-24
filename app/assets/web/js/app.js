/*!
 * app.js — LexiGlass · 法规速查
 */
(function () {
  'use strict';

  /* ============================ 状态 ============================ */
  var S = {
    catalog: [],
    byId: {},
    fav: [],
    recent: [],
    tab: 'home',
    filter: '全部',
    keyword: '',
    mode: 'title',
    prov: '全部',          // 一级：省级行政区（'全部' = 不限）
    local: '全部',         // 二级：属地（省本级 / 市州；'全部' = 该省全部）
    history: [],
    page: 1,
    pageSize: 60,
    cur: null,
    curNode: null,
    maxPack: 0,
    settings: { theme: 'auto', lfont: 15, bfont: 17, immersive: true }
  };

  var CATS = ['全部', '宪法', '法律', '行政法规', '地方法规', '司法解释', '法律解释', '修正案', '监察法规'];
  var SXX = { 3: '有效', 4: '尚未生效', 2: '已修改', 1: '已废止', '-1': '—' };
  var KEY = 'lawglass.v1';
  var L_FONT = [13, 14, 15, 16, 17, 18, 20];
  var B_FONT = [14, 15, 16, 17, 18, 19, 20, 22];

  var $ = function (id) { return document.getElementById(id); };
  var dock = null;

  /* ============================ 存储 ============================ */
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        fav: S.fav, recent: S.recent, settings: S.settings, history: S.history.slice(0, 12)
      }));
    } catch (e) {}
  }
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (Array.isArray(d.fav)) S.fav = d.fav.filter(function (x) { return typeof x === 'string'; });
      if (Array.isArray(d.recent)) S.recent = d.recent.filter(function (x) { return typeof x === 'string'; }).slice(0, 8);
      if (d.settings) {
        if (d.settings.theme === 'dark' || d.settings.theme === 'light' || d.settings.theme === 'auto') S.settings.theme = d.settings.theme;
        if (d.settings.glassMigrated) S.settings.glassMigrated = true;
        if (L_FONT.indexOf(d.settings.lfont) >= 0) S.settings.lfont = d.settings.lfont;
        if (B_FONT.indexOf(d.settings.bfont) >= 0) S.settings.bfont = d.settings.bfont;
        if (d.settings.immersive === false) S.settings.immersive = false;
      }
      if (Array.isArray(d.history)) S.history = d.history.filter(function (x) { return typeof x === 'string'; }).slice(0, 12);
    } catch (e) {}
  }

  /* ============================ 数据层 ============================ */
  /* 全库 2.6 万部法规不按「一部一个文件」放，那样 APK 里会有两万多个 zip 条目，
     读一次要开两万个 handle。改成 500 部一片的分片 JSON：列表只用 index.json，
     点开某部才加载它所在的那一片；片级 LRU，内存里最多留 3 片。 */
  var DOC = {};          // id -> 正文
  var PACKC = {};        // pno -> Promise<list>
  var PACKIDS = {};      // pno -> [id]
  var PACKL = [];        // 已加载片的 LRU 顺序
  var LRU_MAX = 3;

  function packUrl(p) {
    var s = String(p);
    while (s.length < 3) s = '0' + s;
    return 'data/pack/p' + s + '.json';
  }

  function evict() {
    while (PACKL.length > LRU_MAX) {
      var old = PACKL.shift();
      var ids = PACKIDS[old] || [];
      for (var i = 0; i < ids.length; i++) delete DOC[ids[i]];
      delete PACKIDS[old];
      delete PACKC[old];
    }
  }

  function loadPack(pn) {
    if (PACKC[pn]) {
      var at = PACKL.indexOf(pn);
      if (at >= 0) { PACKL.splice(at, 1); PACKL.push(pn); }
      return PACKC[pn];
    }
    var pr = fetch(packUrl(pn)).then(function (r) {
      if (!r.ok) throw new Error('pack ' + pn);
      return r.json();
    }).then(function (list) {
      var ids = [];
      for (var i = 0; i < list.length; i++) {
        DOC[list[i].i] = list[i];
        ids.push(list[i].i);
      }
      PACKIDS[pn] = ids;
      PACKL.push(pn);
      evict();
      return list;
    });
    PACKC[pn] = pr;
    return pr;
  }

  function getDoc(id) {
    if (DOC[id]) return Promise.resolve(DOC[id]);
    var meta = S.byId[id];
    if (!meta || meta.pack < 0) return Promise.reject(new Error('no pack'));
    return loadPack(meta.pack).then(function () {
      if (!DOC[id]) throw new Error('miss ' + id);
      return DOC[id];
    });
  }

  /* ============================ 全文索引 ============================ */
  /* 全量一万三千万字，一次性读进内存会顶到 WebView 堆上限。
     做法是「分片流式扫」：并发读 3 片 → 抽条文本 → 搜 → 丢，只留命中。
     内存峰值 = 3 片正文；全库扫一遍在真机上 6–10 秒，结果逐片回填。 */
  var FT = {
    state: 'idle',
    gen: 0,
    q: '',
    hits: [],
    total: 0,
    done: 0,
    packs: 0,
    promise: null
  };

  function ftBuild(doc) {
    var bs = normBlocks(doc.b);
    var parts = [];
    var marks = [];
    var off = 0;
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var line;
      if (b.type === '条') line = (b.no || '') + '　' + (b.text || '');
      else if (b.title) line = b.title;
      else line = '';                 /* preamble 不建索引：命中「目录」没有意义 */
      if (!line) continue;
      marks.push({ off: off, idx: i, t: b.type });
      parts.push(line);
      off += line.length + 1;
    }
    return { text: parts.join('\n'), marks: marks };
  }

  function ftLocate(marks, pos) {
    var lo = 0, hi = marks.length - 1, best = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (marks[mid].off <= pos) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return marks.length ? marks[best] : { idx: 0, t: '' };
  }

  function ftSnippet(text, pos, qlen) {
    var from = Math.max(0, pos - 26);
    var to = Math.min(text.length, pos + qlen + 46);
    /* 段内是换行分隔的条文，放到一行里显示要压平，否则 <span> 里会出现断行截断感 */
    var a = text.slice(from, pos).replace(/\n/g, ' ');
    var b = text.slice(pos, pos + qlen).replace(/\n/g, ' ');
    var c = text.slice(pos + qlen, to).replace(/\n/g, ' ');
    return { pre: (from > 0 ? '…' : '') + esc(a), hit: esc(b), post: esc(c) + (to < text.length ? '…' : '') };
  }

  function ftScanOne(doc, q, qU, hasUpper) {
    var meta = S.byId[doc.i] || {};
    if (S.filter !== '全部' && meta.flxz !== S.filter) return null;
    if (!inRegion(meta)) return null;
    var built = ftBuild(doc);
    var text = built.text;
    if (!text) return null;
    var pos = 0;
    var count = 0;
    var snips = [];
    while (count < 8) {
      var p = text.indexOf(q, pos);
      if (p < 0 && hasUpper) p = text.indexOf(qU, pos);
      if (p < 0) break;
      snips.push({ pos: p, s: ftSnippet(text, p, q.length) });
      pos = p + q.length;
      count++;
    }
    if (!count) return null;
    snips.sort(function (a, b) {
      var ta = ftLocate(built.marks, a.pos).t === '条' ? 0 : 1;
      var tb = ftLocate(built.marks, b.pos).t === '条' ? 0 : 1;
      return ta - tb;
    });
    return {
      id: doc.i,
      title: meta.title || doc.t,
      flxz: meta.flxz,
      local: meta.local || meta.prov || '',
      count: count,
      marks: built.marks,
      snips: snips
    };
  }

  /* 逐片扫描；onPack 每扫完一片回调一次，供 UI 增量渲染 */
  function ensureFullIndex(q, onPack, prog) {
    var gen = ++FT.gen;
    FT.q = q;
    FT.key = S.filter + '|' + S.prov + '|' + S.local;
    FT.hits = [];
    FT.total = 0;
    FT.done = 0;
    FT.packs = S.maxPack + 1;
    FT.state = 'loading';
    var qU = q.toUpperCase();
    var hasUpper = /[a-z]/.test(q);
    var pno = 0;
    var running = 0;

    return new Promise(function (resolve) {
      function pump() {
        if (gen !== FT.gen) return;
        if (pno > S.maxPack && running === 0) {
          FT.state = 'ready';
          if (onPack) onPack(gen, true);
          resolve(FT.hits);
          return;
        }
        while (running < 3 && pno <= S.maxPack) {
          (function (pn) {
            running++;
            loadPack(pn).then(function (list) {
              if (gen !== FT.gen) return;
              for (var i = 0; i < list.length; i++) {
                var hit = ftScanOne(list[i], q, qU, hasUpper);
                if (hit) {
                  FT.hits.push(hit);
                  FT.total += hit.count;
                }
              }
            }).catch(function () {}).then(function () {
              running--;
              FT.done++;
              if (gen !== FT.gen) return;
              if (prog) prog(FT.done, FT.packs);
              if (onPack) onPack(gen, false);
              if (pno > S.maxPack && running === 0) {
                FT.state = 'ready';
                if (onPack) onPack(gen, true);
                resolve(FT.hits);
              } else {
                pump();
              }
            });
          })(pno++);
        }
      }
      pump();
    });
  }

  /* ============================ 块格式 ============================ */
  /* 分片里为了省体积，block 用数组：[type, 标题/条文号, 正文]
     type: a=条 b=编 c=章 s=节 p=前言                                       */
  var BK = { a: '条', b: '编', c: '章', s: '节', p: 'preamble' };

  function normBlocks(raw) {
    var out = [];
    for (var i = 0; i < (raw || []).length; i++) {
      var b = raw[i];
      if (!b || !b.length) continue;
      if (typeof b === 'object' && !Array.isArray(b) && b.type) { out.push(b); continue; }
      var t = BK[b[0]] || '章';
      if (t === '条') out.push({ type: '条', no: b[1] || '', text: b[2] || '' });
      else if (t === 'preamble') out.push({ type: 'preamble', text: b[1] || '' });
      else out.push({ type: t, title: b[1] || '' });
    }
    return normalizeBlocks(out);
  }

  /* ============================ 全文结果渲染 ============================ */
  function renderFullResult(q) {
    var box = $('lib-list');
    if (!box) return;
    var hits = FT.hits.slice().sort(function (a, b) { return b.count - a.count; });
    if (!hits.length) {
      if (FT.state === 'loading') {
        box.innerHTML = '<div class="loading">正在全文检索… 已扫描 ' + FT.done + '/' + FT.packs + ' 片</div>';
        $('lib-count').textContent = '全文扫描中 · ' + Math.round(FT.done / Math.max(1, FT.packs) * 100) + '%';
      } else {
        box.innerHTML = '<div class="empty"><b>全文里没有「' + esc(q) + '」</b>换个关键词试试</div>';
        $('lib-count').textContent = '';
      }
      $('lib-more').hidden = true;
      return;
    }
    var shown = hits.slice(0, S.page * 24);
    $('lib-count').textContent = '全文命中 ' + fmt(FT.total) + ' 处 · 涉及 ' + fmt(hits.length) + ' 部法规' +
      (FT.state === 'loading' ? ' · 扫描中 ' + Math.round(FT.done / Math.max(1, FT.packs) * 100) + '%' : '') +
      (hits.length > shown.length ? ' · 已显示 ' + shown.length : '');
    box.innerHTML = shown.map(function (h) {
      var lines = h.snips.slice(0, 3).map(function (sn) {
        var blk = ftLocate(h.marks, sn.pos).idx;
        return '<span class="fh-line" data-blk="' + blk + '">' + sn.s.pre +
          '<mark>' + sn.s.hit + '</mark>' + sn.s.post + '</span>';
      }).join('');
      return '<button class="ft-hit" type="button" data-open="' + h.id + '" data-blkjump="' +
        ftLocate(h.marks, h.snips[0].pos).idx + '">' +
        '<span class="fh-title">' + esc(h.title || '') + '</span>' +
        '<span class="fh-meta">' + esc(h.flxz || '') + (h.local ? ' · ' + esc(h.local) : '') +
          ' · 命中 ' + (h.count >= 8 ? '8+' : h.count) + ' 处</span>' +
        '<span class="fh-snip">' + lines + '</span>' +
      '</button>';
    }).join('');
    $('lib-more').hidden = hits.length <= shown.length;
  }

  function runFullSearch(q) {
    var bar = $('ft-bar');
    var fill = $('ft-fill');
    var label = $('ft-label');
    bar.hidden = false;
    fill.style.width = '0%';
    label.textContent = '正在全文检索…';
    FT.hits = [];
    FT.total = 0;
    FT.state = 'loading';
    FT.q = q;
    renderFullResult(q);
    var lastPaint = 0;
    ensureFullIndex(q, function (gen, final) {
      if (gen !== FT.gen) return;
      // 51 片每片回填一次会让列表在 3 秒内重建 51 次，卡且费电；
      // 节流到 250ms 一帧，收尾那次（final）必定刷一次
      var now = Date.now();
      if (final || now - lastPaint > 250) {
        lastPaint = now;
        renderLibrary(false);
      }
    }, function (done, total) {
      var p = total ? Math.round(done / total * 100) : 0;
      fill.style.width = p + '%';
      label.textContent = '扫描 ' + fmt(done) + '/' + fmt(total) + ' 片 · ' + p + '%';
    }).then(function () {
      fill.style.width = '100%';
      label.textContent = '检索完成 · ' + fmt(FT.hits.length) + ' 部命中';
      setTimeout(function () { bar.hidden = true; }, 1200);
    });
  }

  /* ============================ 原生桥 ============================ */
  function bridge(fn, arg) {
    try { if (window.Android && typeof window.Android[fn] === 'function') { window.Android[fn](arg); return true; } } catch (e) {}
    return false;
  }
  function canBack(v) { bridge('setCanBack', !!v); }
  function toast(msg) {
    if (bridge('toast', msg)) return;
    var el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('on'); }, 1800);
  }
  function openUrl(u) {
    if (!bridge('openUrl', u)) window.open(u, '_blank');
  }
  function syncSystemTheme(mode) {
    // 若原生桥提供了 setTheme（本次重制版已加入），同步状态栏/导航栏配色
    bridge('setTheme', mode);
  }

  /* ============================ 主题 / 字号 ============================ */
  /* 主题由 LiquidGlass.theme 统一管理：auto / light / dark 三态，auto 跟随系统 */
  function themeEngine() { return (window.LiquidGlass && window.LiquidGlass.theme) || null; }
  var THEME_ORDER = ['auto', 'light', 'dark'];
  var THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
  var THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };

  function systemTheme() {
    var tg = themeEngine();
    if (tg) return tg.system();
    if (window.__lgSys === 'dark' || window.__lgSys === 'light') return window.__lgSys;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) {}
    return 'light';
  }

  function themeMode() {
    var tg = themeEngine();
    return tg ? tg.mode : (S.settings.theme || 'auto');
  }

  function paintThemeUI(actual, mode) {
    var mtt = $('menu-theme');
    if (mtt) mtt.textContent = THEME_LABEL[mode] || '跟随系统';
    var tv = $('val-theme');
    if (tv) tv.textContent = THEME_LABEL[mode] || '跟随系统';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', actual === 'dark' ? '#08080a' : '#f2f3f7');
    document.documentElement.setAttribute('data-theme-mode', mode);
  }

  function applyTheme(opts) {
    var animate = !(opts && opts.animate === false);
    var tg = themeEngine();
    var actual;
    if (tg) {
      actual = tg.set(S.settings.theme || 'auto', { animate: animate });
    } else {
      actual = S.settings.theme === 'auto' ? systemTheme() : S.settings.theme;
      document.documentElement.setAttribute('data-theme', actual);
    }
    paintThemeUI(actual, themeMode());
    syncSystemTheme(actual);
    return actual;
  }
  function applyFonts() {
    document.documentElement.style.setProperty('--listfont', S.settings.lfont + 'px');
    document.documentElement.style.setProperty('--bodyfont', S.settings.bfont + 'px');
    var a = $('val-lfont'), b = $('val-bfont');
    if (a) a.textContent = S.settings.lfont;
    if (b) b.textContent = S.settings.bfont;
  }
  function cycleTheme() {
    var tg = themeEngine();
    if (tg) {
      tg.toggle();
      S.settings.theme = tg.mode;
      paintThemeUI(tg.resolve(), tg.mode);
    } else {
      var i = THEME_ORDER.indexOf(S.settings.theme);
      S.settings.theme = THEME_ORDER[(i + 1) % THEME_ORDER.length];
      applyTheme();
    }
    save();
    if (dock) dock.refresh();
  }
  function cycleListFont() {
    var i = L_FONT.indexOf(S.settings.lfont);
    S.settings.lfont = L_FONT[(i + 1) % L_FONT.length];
    applyFonts(); save();
  }
  function cycleBodyFont() {
    var i = B_FONT.indexOf(S.settings.bfont);
    S.settings.bfont = B_FONT[(i + 1) % B_FONT.length];
    applyFonts(); save();
  }

  function setThemeMode(mode) {
    var tg = themeEngine();
    S.settings.theme = mode;
    if (tg) {
      tg.set(mode, { animate: true });
      paintThemeUI(tg.resolve(), tg.mode);
    } else {
      applyTheme();
    }
    save();
    if (dock) dock.refresh();
  }

  /* ============================ 选项窗口 ============================ */
  /* 三种形态：
       pick    单选列表（显示外观 / 字号 / 沉浸模式）
       info    信息面板（关于本软件 / 数据来源 / 离线数据）
       confirm 二次确认（清空书签）                                        */
  var SHEET = { open: false, kind: '', onPick: null, onOk: null, value: null };

  var FONT_NAME = { 13: '特小', 14: '小', 15: '标准', 16: '中', 17: '大', 18: '特大', 19: '特大+', 20: '超大', 22: '巨无霸' };

  function sheetSeed() {
    // 弹窗里的玻璃件在 hidden / display:none 状态下尺寸为 0，折射贴图生成不出来。
    // 显示后必须重扫一遍（refresh 的 scope 是 querySelectorAll，传元素本身扫不到自己，
    // 所以这里直接从 document 扫，代价也就是十几个元素）。
    if (!window.LiquidGlass || !window.LiquidGlass.refresh) return;
    requestAnimationFrame(function () {
      window.LiquidGlass.refresh(document);
    });
  }

  function openSheet(cfg) {
    var mask = $('opt-mask');
    var body = $('opt-body');
    var title = $('opt-title');
    var foot = $('opt-foot');
    if (!mask || !body) return;

    SHEET.open = true;
    SHEET.kind = cfg.kind || 'info';
    SHEET.onPick = cfg.onPick || null;
    SHEET.onOk = cfg.onOk || null;
    SHEET.value = cfg.value;

    title.textContent = cfg.title || '选项';
    var backBtn = $('opt-back');
    if (backBtn) {
      backBtn.hidden = !cfg.back;
      backBtn._fn = cfg.back || null;
      var head = document.querySelector('.opt-head');
      if (head) head.classList.toggle('has-back', !!cfg.back);
    }

    var html = '';
    var i;

    if (cfg.kind === 'pick') {
      var items = cfg.items || [];
      if (cfg.note) html += '<p class="opt-note" style="margin:2px 12px 10px">' + esc(cfg.note) + '</p>';
      if (!items.length) {
        html = '<div class="opt-empty">没有可选项</div>';
      } else {
        for (i = 0; i < items.length; i++) {
          var it = items[i];
          var on = String(it.value) === String(cfg.value);
          html += '<button class="opt-item' + (it.sub ? ' has-sub' : '') +
            '" type="button" role="radio" aria-checked="' +
            (on ? 'true' : 'false') + '" data-val="' + esc(String(it.value)) + '">' +
            '<span class="opt-label">' + esc(it.label) + '</span>' +
            (it.preview
              ? '<span class="opt-preview" style="font-size:' + (Number(it.preview) || 15) + 'px">Aa</span>'
              : '') +
            (it.desc || it.hint
              ? '<span class="opt-hint">' + esc(it.desc || it.hint) + '</span>'
              : '') +
            (it.sub
              ? '<span class="opt-arrow"><svg viewBox="0 0 24 24"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg></span>'
              : '<span class="opt-tick"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-8.5"/></svg></span>') +
            '</button>';
        }
      }
    } else if (cfg.kind === 'confirm') {
      html = '<div class="opt-note" style="margin:6px 12px 12px;font-size:14px;line-height:1.65;color:var(--ink-2)">' +
        esc(cfg.message || '') + '</div>';
    } else {
      if (cfg.head) {
        html += '<div class="opt-about-head">' +
          '<div class="opt-icon">' + esc(cfg.head.glyph || '法') + '</div>' +
          '<div><div class="n">' + esc(cfg.head.name || '') + '</div>' +
          '<div class="s">' + esc(cfg.head.sub || '') + '</div></div></div>';
      }
      var rows = cfg.rows || [];
      for (i = 0; i < rows.length; i++) {
        html += '<div class="opt-info"><span class="k">' + esc(rows[i][0]) + '</span>' +
          '<span class="v' + (rows[i][2] ? ' ' + rows[i][2] : '') + '">' + esc(rows[i][1]) + '</span></div>';
      }
      if (cfg.note) html += '<p class="opt-note">' + esc(cfg.note) + '</p>';
      if (cfg.link) {
        html += '<button class="opt-link" type="button" id="opt-link" data-url="' +
          esc(cfg.link.url) + '">' + esc(cfg.link.text) + '</button>';
      }
    }

    body.innerHTML = html;
    body.scrollTop = 0;

    var showFoot = cfg.kind === 'confirm';
    foot.hidden = !showFoot;
    if (showFoot) {
      var ok = $('opt-ok');
      ok.textContent = cfg.okText || '确定';
      ok.className = 'opt-btn ' + (cfg.danger ? 'opt-btn--danger' : 'opt-btn--primary');
    }

    mask.hidden = false;
    sheetSeed();
  }

  function closeSheet() {
    var mask = $('opt-mask');
    if (!mask || mask.hidden) return;
    mask.hidden = true;
    SHEET.open = false;
    SHEET.onPick = null;
    SHEET.onOk = null;
  }

  function pickInSheet(val) {
    var items = $('opt-body').querySelectorAll('.opt-item');
    for (var i = 0; i < items.length; i++) {
      items[i].setAttribute('aria-checked', items[i].getAttribute('data-val') === String(val) ? 'true' : 'false');
    }
    SHEET.value = val;
    if (SHEET.onPick) SHEET.onPick(val);
  }

  /* ---- 三个真正的选项窗口 ---- */
  function openThemeSheet() {
    openSheet({
      kind: 'pick',
      title: '显示外观',
      value: themeMode(),
      items: [
        { value: 'auto', label: '跟随系统', hint: '随系统深浅色切换' },
        { value: 'light', label: '浅色', hint: '始终浅色' },
        { value: 'dark', label: '深色', hint: '始终深色' }
      ],
      onPick: function (v) { setThemeMode(v); }
    });
  }

  function openFontSheet(which) {
    var isList = which === 'list';
    if (which === 'both') isList = false;
    var pool = isList ? L_FONT : B_FONT;
    var cur = isList ? S.settings.lfont : S.settings.bfont;
    var items = [];
    for (var i = 0; i < pool.length; i++) {
      items.push({
        value: pool[i],
        label: pool[i] + ' px',
        hint: FONT_NAME[pool[i]] || '',
        preview: pool[i]
      });
    }
    openSheet({
      kind: 'pick',
      title: isList ? '列表字号' : '正文字号',
      value: cur,
      items: items,
      onPick: function (v) {
        if (isList) S.settings.lfont = Number(v); else S.settings.bfont = Number(v);
        applyFonts(); save();
        if (isList) { renderLibrary(false); renderFav(); renderRecent(); }
      }
    });
  }

  function immersiveOn() { return S.settings.immersive !== false; }

  function openImmersiveSheet() {
    openSheet({
      kind: 'pick',
      title: '沉浸模式',
      value: immersiveOn() ? 'on' : 'off',
      items: [
        { value: 'on', label: '隐藏状态栏', hint: '内容顶到屏幕边缘' },
        { value: 'off', label: '显示状态栏', hint: '保留时间与电量' }
      ],
      onPick: function (v) {
        var on = v === 'on';
        S.settings.immersive = on;
        save();
        bridge('setImmersive', on);
        var rv = $('val-immersive');
        if (rv) rv.textContent = on ? '隐藏状态栏' : '显示状态栏';
      }
    });
  }

  function openOfflineSheet() {
    openSheet({
      kind: 'info',
      title: '离线数据',
      rows: [
        ['法规总数', $('val-offline').textContent.replace(/^.*·\s*/, '')],
        ['已入库条目', $('st-total') ? $('st-total').textContent : '—'],
        ['总字数', ($('st-chars') ? $('st-chars').textContent : '—') + ' 万字'],
        ['现行有效', ($('st-valid') ? $('st-valid').textContent : '—') + ' 部'],
        ['存储方式', '随安装包内置，不联网'],
        ['书签', ($('val-favcount') ? $('val-favcount').textContent : '0 条') + '（本机保存）']
      ],
      note: '全部法规文本随安装包一起打包，检索与阅读全程离线，不产生任何网络请求。'
    });
  }

  function openSourceSheet() {
    openSheet({
      kind: 'info',
      title: '数据来源',
      rows: [
        ['来源', '国家法律法规数据库'],
        ['站点', 'flk.npc.gov.cn'],
        ['收录', '法律 / 行政法规 / 司法解释 / 地方性法规'],
        ['更新', '随版本发布同步入库'],
        ['使用', '仅供查阅，以官方发布文本为准']
      ],
      link: { text: '在浏览器中打开来源站点', url: 'https://flk.npc.gov.cn' }
    });
  }

  function openAboutSheet() {
    var ver = $('val-version') ? $('val-version').textContent : '3.1.4';
    var pkg = '';
    try {
      if (window.Android && typeof window.Android.getPackageId === 'function') pkg = window.Android.getPackageId();
    } catch (e) {}
    openSheet({
      kind: 'info',
      title: '关于本软件',
      head: { glyph: '法', name: 'LexiGlass · 法规速查', sub: '离线版 · v' + ver },
      rows: [
        ['应用名称', 'LexiGlass · 法规速查'],
        ['版本号', ver],
        ['包名', pkg || 'com.lexi.reader', 'mono'],
        ['开发者', 'Zihium'],
        ['界面设计', 'Liquid Glass'],
        ['内容语种', '简体中文'],
        ['运行环境', 'Android 8.0 及以上 · 纯离线'],
        ['数据来源', '国家法律法规数据库'],
        ['字体', '系统默认（思源黑体 / 苹方）']
      ],
      note: 'LexiGlass 是一款完全离线的法律法规速查应用，内置 2.5 万部法规全文，' +
        '支持标题与全文关键词检索、按地区两级浏览。' +
        '界面采用液态玻璃（Liquid Glass）设计语言。' +
        '法规文本来源于公开的国家法律法规数据库，版权归原发布机关所有。',
      link: { text: '访问项目主页', url: 'https://github.com/Zihium/lexiglass' }
    });
  }

  function openClearFavConfirm() {
    if (!S.fav.length) { toast('书签已是空的'); return; }
    openSheet({
      kind: 'confirm',
      title: '清空书签',
      message: '将删除全部 ' + S.fav.length + ' 条书签，此操作不可撤销。',
      okText: '清空',
      danger: true,
      onOk: function () {
        S.fav = []; save(); syncFavCounters(); toast('书签已清空');
      }
    });
  }

  /* ============================ 工具 ============================ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function wan(n) { return (n / 1e4).toFixed(0); }
  function isFav(id) { return S.fav.indexOf(id) >= 0; }
  function toggleFav(id) {
    var i = S.fav.indexOf(id);
    if (i >= 0) S.fav.splice(i, 1); else S.fav.unshift(id);
    save(); syncFavCounters();
    toast(i >= 0 ? '已取消收藏' : '已加入书签');
    return i < 0;
  }
  function pushRecent(id) {
    S.recent = [id].concat(S.recent.filter(function (x) { return x !== id; })).slice(0, 8);
    save(); renderRecent();
  }
  function syncFavCounters() {
    $('st-fav').textContent = S.fav.length;
    $('val-favcount').textContent = S.fav.length + ' 条';
    renderFav();
  }

  /* ============================ 启动 ============================ */
  /* ============================ 版本号 ============================ */
  /* 优先从原生桥取真实 versionName / 包名；浏览器里退回 HTML 里的静态值 */
  function paintVersion() {
    var v = '';
    var p = '';
    try {
      if (window.Android && typeof window.Android.getVersionName === 'function') v = window.Android.getVersionName();
      if (window.Android && typeof window.Android.getPackageId === 'function') p = window.Android.getPackageId();
    } catch (e) {}
    var el = $('val-version');
    if (el) {
      if (v) el.textContent = v;
      el.setAttribute('title', p ? p + ' · v' + (v || el.textContent) : '');
    }
  }

  /* ============================ 安全区 ============================ */
  /* WebView 是 edge-to-edge，env(safe-area-inset-*) 恒为 0；
     原生把真实 inset 推过来，CSS 里 --top / --bottom 就读这两个值 */
  function applySafeInsets(top, bottom) {
    var r = document.documentElement.style;
    r.setProperty('--safe-top', (Math.max(0, Number(top) || 0)) + 'px');
    r.setProperty('--safe-bottom', (Math.max(0, Number(bottom) || 0)) + 'px');
  }
  window.__lgInsets = function (t, b) { applySafeInsets(t, b); };

  function syncInsets() {
    try {
      if (window.Android && typeof window.Android.getInsets === 'function') {
        var pair = String(window.Android.getInsets() || '').split(',');
        if (pair.length === 2) applySafeInsets(pair[0], pair[1]);
      }
    } catch (e) {}
  }

  function boot() {    load();

    // 一次性迁移：旧版本只存 light/dark 二态，升级后默认改为跟随系统
    var tg = themeEngine();
    if (tg) {
      tg.read();
      if (!S.settings.glassMigrated) {
        S.settings.theme = 'auto';
        S.settings.glassMigrated = true;
        save();
      }
      tg.onChange(function (actual, mode) {
        S.settings.theme = mode;
        save();
        paintThemeUI(actual, mode);
        if (dock) dock.refresh();
      });
      applyTheme({ animate: false });
    } else {
      applyTheme();
    }
    applyFonts();
    moveSegPill();
    renderChips();
    bindEvents();
    setupDock();
    paintVersion();
    bridge('setImmersive', immersiveOn());
    syncInsets();
    var riv = $('val-immersive');
    if (riv) riv.textContent = immersiveOn() ? '隐藏状态栏' : '显示状态栏';

    fetch('data/index.json').then(function (r) { return r.json(); }).then(function (data) {
      S.catalog = (data || []).map(function (a) {
        return {
          bbbs: a[0], title: a[1], flxz: a[2], zdjg: a[3], gbrq: a[4], sxrq: a[5],
          sxx: a[6], prov: a[7] || '', local: a[8] || '', chars: a[9] || 0, pack: a[10]
        };
      });
      S.catalog.forEach(function (d) {
        S.byId[d.bbbs] = d;
        if (typeof d.pack === 'number' && d.pack > S.maxPack) S.maxPack = d.pack;
      });
      // 预计算分类计数与地区树：首页/法规库/弹窗反复用到，
      // 否则每次渲染都全量扫 2.5 万条（renderCats + renderChips + renderRegionChips 各扫一遍）
      var catCount = {};
      S.catalog.forEach(function (d) { catCount[d.flxz] = (catCount[d.flxz] || 0) + 1; });
      S.catCount = catCount;
      S.regionTreeCache = buildRegionTree();
      var chars = S.catalog.reduce(function (a, b) { return a + (b.chars || 0); }, 0);
      var valid = S.catalog.filter(function (d) { return d.sxx === 3; }).length;
      var locals = S.catalog.filter(function (d) { return d.flxz === '地方法规'; });

      $('st-total').textContent = fmt(S.catalog.length);
      $('st-chars').textContent = wan(chars);
      $('st-valid').textContent = fmt(valid);
      $('lib-sub').textContent = '共 ' + fmt(S.catalog.length) + ' 部 · 标题或全文检索';
      var hs = $('hero-sub');
      if (hs) hs.textContent = fmt(S.catalog.length) + ' 部 · ' + wan(chars) + ' 万字 · 完全离线';
      var tree = regionTree();
      var provN = tree.length;
      var cityN = tree.reduce(function (a, t) { return a + t.subs.length - 1; }, 0);
      var foot = document.querySelector('#tab-home .foot-note');
      if (foot) {
        foot.textContent = '数据来自国家法律法规数据库，共 ' + fmt(S.catalog.length) +
          ' 部（含 ' + provN + ' 个省级行政区与 ' + cityN + ' 个市州的 ' +
          fmt(locals.length) +
          ' 部地方性法规），全部离线保存，不联网、不上传。支持标题检索与全文关键词检索；点击底部任意标签切换，按住 Dock 左右拖动可直接跳转。';
      }
      var qs = $('qt-search');
      if (qs) qs.textContent = '在 ' + wan(chars) + ' 万字正文里找';
      var qst = $('qt-stats');
      if (qst) qst.textContent = fmt(S.catalog.length) + ' 部 · ' + provN + ' 省 · ' + cityN + ' 市州';
      $('val-offline').textContent = fmt(S.catalog.length) + ' 部 · ' + wan(chars) + ' 万字';
      $('foot-ver').textContent = 'LexiGlass · 离线版 · 共 ' + fmt(S.catalog.length) + ' 部法规';

      $('st-fav').textContent = S.fav.length;
      $('val-favcount').textContent = S.fav.length + ' 条';

      renderChips();
      renderRegionChips();
      renderRecent();
      renderCats();
      renderRegionGrid();
      renderLibrary();
      renderFav();
      setTimeout(moveSegPill, 30);
    }).catch(function () {
      $('lib-list').innerHTML = '<div class="empty"><b>法规库装载失败</b>请重新安装应用</div>';
      $('lib-count').textContent = '';
    });
  }

  /* ============================ 首页 ============================ */
  function renderRecent() {
    var box = $('recent-list');
    if (!box) return;
    var items = S.recent.map(function (id) { return S.byId[id]; }).filter(Boolean).slice(0, 3);
    if (!items.length) {
      box.innerHTML = '<div class="card"><div class="empty" style="padding:28px 18px"><b>还没有阅读记录</b>去法规库挑一部开始</div></div>';
      return;
    }
    box.innerHTML = items.map(lawCard).join('');
  }

  function renderCats() {
    var box = $('cat-grid');
    var colors = ['#508fdf', '#7b77d7', '#1a987c', '#c18243', '#4f9ad1', '#a06bb5', '#3f8f6b'];
    box.innerHTML = CATS.slice(1).map(function (c, i) {
      var n = S.catCount ? (S.catCount[c] || 0) : S.catalog.filter(function (d) { return d.flxz === c; }).length;
      return '<button class="cat-tile" type="button" data-cat="' + esc(c) + '">' +
        '<span class="cat-dot" style="background:' + colors[i % colors.length] + '"></span>' +
        '<span class="n">' + esc(c) + '</span><span class="c">' + n + '</span></button>';
    }).join('');
  }

  /* ============================ 列表 ============================ */
  function lawCard(d) {
    var fav = isFav(d.bbbs);
    var sxx = d.sxx === 3 ? 'ok' : (d.sxx === 4 ? 'wait' : '');
    return '<div class="law' + (fav ? ' is-fav' : '') + '" data-id="' + d.bbbs + '">' +
      '<button class="law-open" type="button" data-open="' + d.bbbs + '">' +
        '<span class="law-mark">' + esc((d.flxz || '法').slice(0, 1)) + '</span>' +
        '<span class="law-body">' +
          '<span class="law-title">' + esc(d.title) + '</span>' +
          '<span class="law-meta">' +
            '<span class="tag ' + sxx + '">' + (SXX[d.sxx] || '—') + '</span>' +
            '<span>' + esc(d.flxz || '') + (d.local ? '<span class="law-region">' + esc(d.local) + '</span>' : '') + '</span>' +
            '<span class="dot"></span>' +
            '<span>' + esc(d.gbrq || '') + '</span>' +
          '</span>' +
        '</span>' +
      '</button>' +
      '<button class="law-fav' + (fav ? ' on' : '') + '" type="button" data-fav="' + d.bbbs + '" aria-label="收藏">' +
        '<svg viewBox="0 0 24 24"><path d="M6.6 4.6h10.8v15.6l-5.4-4.2-5.4 4.2z"/></svg>' +
      '</button>' +
    '</div>';
  }

  function inRegion(d) {
    if (S.prov !== '全部' && d.prov !== S.prov) return false;
    if (S.local !== '全部' && d.local !== S.local) return false;
    return true;
  }

  function filtered() {
    var kw = S.keyword.toLowerCase();
    return S.catalog.filter(function (d) {
      if (S.filter !== '全部' && d.flxz !== S.filter) return false;
      if (!inRegion(d)) return false;
      if (!kw) return true;
      return (d.title || '').toLowerCase().indexOf(kw) >= 0 || (d.zdjg || '').toLowerCase().indexOf(kw) >= 0;
    });
  }

  function renderLibrary(reset) {
    if (reset) S.page = 1;
    if (S.mode === 'full') {
      var kw = (S.keyword || '').trim();
      if (!kw || kw.length < 2) {
        $('lib-list').innerHTML = '<div class="empty"><b>全文搜索</b>输入至少 2 个字，在 ' +
          fmt(S.catalog.length) + ' 部法规的正文里查找</div>';
        $('lib-count').textContent = '';
        $('lib-more').hidden = true;
        return;
      }
      var fkey = S.filter + '|' + S.prov + '|' + S.local;
      if (FT.q === kw && FT.key === fkey) { renderFullResult(kw); return; }
      runFullSearch(kw);
      return;
    }
    var list = filtered();
    var shown = list.slice(0, S.page * S.pageSize);
    var box = $('lib-list');
    if (!list.length) {
      box.innerHTML = '<div class="empty"><b>没有找到相关法规</b>换个关键词，或切换分类试试</div>';
      $('lib-count').textContent = '';
      $('lib-more').hidden = true;
      return;
    }
    $('lib-count').textContent = '共 ' + fmt(list.length) + ' 部' + (list.length > shown.length ? ' · 已显示 ' + shown.length : '');
    box.innerHTML = shown.map(lawCard).join('');
    $('lib-more').hidden = list.length <= shown.length;
  }

  function renderFav() {
    var box = $('fav-list');
    if (!box) return;
    var items = S.fav.map(function (id) { return S.byId[id]; }).filter(Boolean);
    if (!items.length) {
      box.innerHTML = '<div class="empty"><b>书签是空的</b>在阅读页点击右上角书签，或在列表项右侧点收藏</div>';
      return;
    }
    box.innerHTML = items.map(lawCard).join('');
  }

  function renderChips() {
    var box = $('chips');
    setTimeout(function () { if (typeof renderRegionChips === 'function') renderRegionChips(); }, 0);
    box.innerHTML = CATS.map(function (c) {
      var n = c === '全部' ? S.catalog.length : (S.catCount ? (S.catCount[c] || 0) : S.catalog.filter(function (d) { return d.flxz === c; }).length);
      return '<button class="chip' + (c === S.filter ? ' on' : '') + '" type="button" data-chip="' + esc(c) + '">' +
        esc(c) + (n ? '<span class="n">' + n + '</span>' : '') + '</button>';
    }).join('');
  }

  /* ============================ 阅读 ============================ */
  function openLaw(id, jumpBlk) {
    var meta = S.byId[id];
    S.curNode = id;
    $('reader').classList.add('on');
    $('reader').setAttribute('aria-hidden', 'false');
    document.body.classList.add('reader-open');
    $('reader-title').textContent = meta ? meta.title : '加载中';
    $('reader-body').innerHTML = '<div class="loading">正在装载…</div>';
    $('reader-scroll').scrollTop = 0;
    canBack(true);
    updateFavIcon(id);
    pushRecent(id);
    // 阅读页此前是 display:none，页内搜索栏尺寸为 0 —— 折射贴图要在这时补生成
    sheetSeed();

    getDoc(id).then(function (raw) {
      var doc = {
        id: id,
        title: raw.t || (meta ? meta.title : ''),
        flxz: (meta && meta.flxz) || raw.f || '',
        zdjg: raw.n || '',
        gbrq: raw.g || '',
        sxrq: raw.s || '',
        sxx: raw.x,
        prov: raw.p || '',
        local: raw.d || '',
        blocks: normBlocks(raw.b)
      };
      S.cur = doc;
      S.curBlocks = doc.blocks;
      $('reader-title').textContent = doc.title;
      renderDoc(doc, S.curBlocks);
      $('reader-scroll').scrollTop = 0;
      if (typeof jumpBlk === 'number' && jumpBlk > 0) {
        setTimeout(function () { scrollToBlock(jumpBlk); }, 60);
      }
    }).catch(function () {
      $('reader-body').innerHTML = '<div class="empty"><b>正文装载失败</b>请返回后重试</div>';
    });
  }

  function renderDoc(doc, blocks) {
    var info = '<div class="reader-info">' +
      '<div class="h">' + esc(doc.title) + '</div>' +
      row('分类', esc(doc.flxz || '—')) +
      row('制定机关', esc(doc.zdjg || '—')) +
      (doc.local ? row('适用地区', esc(doc.prov ? doc.prov + ' · ' + doc.local : doc.local)) : '') +
      row('公布日期', esc(doc.gbrq || '—')) +
      row('施行日期', esc(doc.sxrq || '—')) +
      row('效力', '<span style="color:' + (doc.sxx === 3 ? 'var(--accent)' : '#b4761f') + '">' + (SXX[doc.sxx] || '—') + '</span>') +
    '</div>';

    var n = 0;
    var body = (blocks || []).map(function (b, i) {
      if (b.type === '章' || b.type === '编') return '<div class="chap" id="blk-' + i + '">' + esc(b.title) + '</div>';
      if (b.type === '节') return '<div class="sec" id="blk-' + i + '">' + esc(b.title) + '</div>';
      if (b.type === '条') {
        n++;
        var no = (b.no && String(b.no).trim()) || ('第' + cnNum(n) + '条');
        return '<div class="art" id="art-' + n + '" data-blk="' + i + '"><span class="no">' + esc(no) + '</span>' + esc(b.text).replace(/\n/g, '<br>') + '</div>';
      }
      return '<div class="pre">' + esc(b.text || '').replace(/\n/g, '<br>') + '</div>';
    }).join('');

    $('reader-body').innerHTML = info + '<div class="doc" id="doc">' + body + '</div>';
  }

  function normTitle(t) { return String(t || '').replace(/\s|\u3000/g, ''); }

  /* 数据里 preamble 末尾若带「目 录」，其后会重复一遍全部章节标题。
     找到第二次出现的首章标题，把它之前的章节块全部丢弃（保留序言）。 */
  function normalizeBlocks(raw) {
    var bs = (raw || []).slice();
    var p0 = bs[0];
    if (!p0 || p0.type !== 'preamble') return bs;
    if (normTitle(p0.text).indexOf('目录') < 0) return bs;
    var k = 1;
    while (k < bs.length && (bs[k].type === '章' || bs[k].type === '编' || bs[k].type === '节')) k++;
    if (k <= 1) return bs;
    var first = normTitle(bs[1].title);
    var m = -1;
    for (var i = k; i < bs.length; i++) {
      if ((bs[i].type === '章' || bs[i].type === '编' || bs[i].type === '节') && normTitle(bs[i].title) === first) { m = i; break; }
    }
    if (m < 0) return bs;
    return bs.filter(function (b, i) {
      if (i === 0 || i >= m) return true;
      return !(b.type === '章' || b.type === '编' || b.type === '节');
    });
  }

  function cnNum(n) {
    var d = '零一二三四五六七八九';
    if (n <= 10) return n === 10 ? '十' : d[n];
    if (n < 20) return '十' + d[n % 10];
    if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
    if (n < 1000) {
      var r = d[Math.floor(n / 100)] + '百';
      var rest = n % 100;
      if (!rest) return r;
      if (rest < 10) return r + '零' + d[rest];
      return r + (rest < 20 ? '一' : '') + cnNum(rest);
    }
    return String(n);
  }

  function row(k, v) {
    return '<div class="r"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  }

  function updateFavIcon(id) {
    var on = isFav(id);
    var btn = $('reader-fav');
    btn.classList.toggle('on', on);
    btn.style.color = on ? 'var(--accent)' : '';
    btn.querySelector('svg').style.fill = on ? 'currentColor' : 'none';
    btn.setAttribute('aria-label', on ? '取消收藏' : '收藏');
  }

  function closeReader() {
    $('reader').classList.remove('on');
    $('reader').setAttribute('aria-hidden', 'true');
    document.body.classList.remove('reader-open');
    S.cur = null;
    S.curNode = null;
    canBack(S.tab !== 'home');
    renderFav();
    if (S.tab === 'home') renderRecent();
  }

  function docSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    var scroller = $('reader-scroll');
    var nodes = document.querySelectorAll('#reader-body .art');
    var hit = null;
    if (/^\d+$/.test(q)) {
      hit = document.getElementById('art-' + q);
      if (!hit) { toast('未找到第 ' + q + ' 条'); return; }
    } else {
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].textContent.indexOf(q) >= 0) { hit = nodes[i]; break; }
      }
      if (!hit) { toast('本页未匹配到「' + q + '」'); return; }
    }
    var prev = document.querySelectorAll('.art.hl');
    for (var k = 0; k < prev.length; k++) prev[k].classList.remove('hl');
    hit.classList.add('hl');
    var top = hit.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientHeight * 0.35;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  /* ============================ 目录 ============================ */
  function openToc() {
    if (!S.cur) return;
    var items = (S.curBlocks || []).map(function (b, i) {
      if (b.type === '章' || b.type === '编') return '<button class="toc-item" type="button" data-blk="' + i + '">' + esc(b.title) + '</button>';
      if (b.type === '节') return '<button class="toc-item lv2" type="button" data-blk="' + i + '">' + esc(b.title) + '</button>';
      return '';
    }).join('');
    $('toc-body').innerHTML = items || '<div class="empty">本法规无章节结构</div>';
    $('toc-mask').hidden = false;
    sheetSeed();
    if (window.LiquidGlass && window.LiquidGlass.refresh) window.LiquidGlass.refresh($('toc-sheet'));
    canBack(true);
  }
  function closeToc() {
    $('toc-mask').hidden = true;
    canBack(!!S.cur);
  }
  function scrollToBlock(i, opts) {
    var el = document.getElementById('blk-' + i) ||
             document.querySelector('#reader-body [data-blk="' + i + '"]');
    if (!el) return false;
    var scroller = $('reader-scroll');
    /* 头部是 sticky 的，占掉顶部约 120px（顶栏 48 + 搜索 56 + 上下留白），
       跳转时把这段高度减掉，目标条款才不会落在玻璃下面 */
    var headH = document.querySelector('.reader-head');
    var pad = headH ? Math.round(headH.getBoundingClientRect().height) + 8 : 120;
    var top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - pad;
    scroller.scrollTo({ top: Math.max(0, top), behavior: (opts && opts.instant) ? 'auto' : 'smooth' });
    return true;
  }

  function jumpBlock(i) {
    scrollToBlock(i);
    closeToc();
  }

  /* ============================ 更多菜单 ============================ */
  function moreOpen() { return !$('more-menu').hidden; }

  function toggleMore(force) {
    var menu = $('more-menu');
    var btn = $('btn-more');
    var next = (typeof force === 'boolean') ? force : menu.hidden;
    menu.hidden = !next;
    btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      var mt = $('menu-theme');
      var mf = $('menu-font');
      var mr = $('menu-region');
      var mh = $('menu-history');
      var mv = $('menu-version');
      if (mt) mt.textContent = THEME_LABEL[S.settings.theme] || '跟随系统';
      if (mf) mf.textContent = S.settings.bfont + 'px';
      paintMenuRegion();
      if (mh) mh.textContent = S.history.length + ' 条';
      if (mv) mv.textContent = ($('val-version') || {}).textContent || '1.0.0';
      sheetSeed();
      if (window.LiquidGlass && window.LiquidGlass.refresh) window.LiquidGlass.refresh(document);
    }
  }

  function paintMenuRegion() {
    var txt;
    if (S.prov === '全部') txt = '全国';
    else if (S.local === '全部') txt = S.prov;
    else txt = S.local === S.prov ? '省本级' : S.local;
    var mr = $('menu-region');
    if (mr) mr.textContent = txt;
    var qr = $('qt-region');
    if (qr) qr.textContent = S.prov === '全部' ? '省 → 市州两级筛选' : txt + ' · 点此换地区';
  }

  function doMoreAct(act) {
    toggleMore(false);
    if (act === 'search-all') {
      S.filter = '全部';
      S.prov = '全部';
      S.local = '全部';
      renderChips();
      renderRegionChips();
      goto(1);
      setSearchMode('full');
      setTimeout(function () { var q = $('q'); if (q) q.focus(); }, 260);
    } else if (act === 'random') {
      openRandomLaw();
    } else if (act === 'region') {
      openRegionSheet();
    } else if (act === 'theme') {
      openThemeSheet();
    } else if (act === 'font') {
      openFontSheet('both');
    } else if (act === 'history') {
      openHistorySheet();
    } else if (act === 'stats') {
      openStatsSheet();
    } else if (act === 'about') {
      openAboutSheet();
    }
  }

  /* ============================ 搜索范围 ============================ */
  function moveSegPill() {
    var pill = $('seg-pill');
    var on = document.querySelector('#search-mode .seg-btn.on');
    if (!pill || !on) return;
    pill.style.width = on.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + (on.offsetLeft - 3) + 'px)';
  }

  function setSearchMode(m) {
    S.mode = m === 'full' ? 'full' : 'title';
    var btns = document.querySelectorAll('#search-mode .seg-btn');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-mode') === S.mode;
      btns[i].classList.toggle('on', on);
      btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    moveSegPill();
    var q = $('q');
    if (q) q.placeholder = S.mode === 'full' ? '全文搜索：输入条文里的关键词…' : '搜索法规名称、发布机关…';
    if (S.mode === 'full') {
      $('ft-bar').hidden = true;
      var kw = (S.keyword || '').trim();
      if (kw.length >= 2) runFullSearch(kw);
      else renderLibrary(true);
    } else {
      $('ft-bar').hidden = true;
      renderLibrary(true);
    }
  }

  /* ============================ 地区树 ============================ */
  /* 两级：一级 = 31 个省级行政区；二级 = 省本级 + 下辖市州。
     index 里 prov 是省级全名，local 是属地（省级机关 = 省名，市级/县级 = 所属地级市）。 */
  function regionTree() {
    if (S.regionTreeCache) return S.regionTreeCache;
    return buildRegionTree();
  }

  function buildRegionTree() {
    var map = {};
    S.catalog.forEach(function (d) {
      if (!d.prov) return;
      var p = map[d.prov];
      if (!p) p = map[d.prov] = { name: d.prov, n: 0, subs: [], _s: {} };
      p.n++;
      var loc = d.local || d.prov;
      var s = p._s[loc];
      if (!s) s = p._s[loc] = { name: loc, n: 0 };
      s.n++;
    });
    var out = [];
    Object.keys(map).forEach(function (k) {
      var p = map[k];
      var subs = Object.keys(p._s).map(function (x) { return p._s[x]; });
      subs.sort(function (a, b) {
        var sa = a.name === p.name ? 0 : 1;
        var sb = b.name === p.name ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return b.n - a.n;
      });
      out.push({ name: p.name, n: p.n, subs: subs });
      delete p._s;
    });
    out.sort(function (a, b) { return b.n - a.n; });
    S.regionTreeCache = out;
    return out;
  }

  function provCount(name) {
    var t = regionTree();
    for (var i = 0; i < t.length; i++) if (t[i].name === name) return t[i].n;
    return 0;
  }

  function renderRegionChips() {
    paintMenuRegion();
    var box = $('region-chips');
    var box2 = $('city-chips');
    if (!box) return;
    var tree = regionTree();
    var show = S.filter === '地方法规';
    box.hidden = !show;
    if (box2) box2.hidden = !show || S.prov === '全部';
    if (!show) return;

    var total = tree.reduce(function (a, t) { return a + t.n; }, 0);
    box.innerHTML = '<button class="chip' + (S.prov === '全部' ? ' on' : '') +
      '" type="button" data-prov="全部">全部<span class="n">' + fmt(total) + '</span></button>' +
      tree.map(function (t) {
        return '<button class="chip' + (S.prov === t.name ? ' on' : '') +
          '" type="button" data-prov="' + esc(t.name) + '">' + esc(t.name) +
          '<span class="n">' + fmt(t.n) + '</span></button>';
      }).join('');

    if (!box2) return;
    if (S.prov === '全部') { box2.innerHTML = ''; return; }
    var cur = null;
    for (var i = 0; i < tree.length; i++) if (tree[i].name === S.prov) cur = tree[i];
    if (!cur) { box2.innerHTML = ''; return; }
    box2.innerHTML = '<button class="chip' + (S.local === '全部' ? ' on' : '') +
      '" type="button" data-local="全部">全省<span class="n">' + fmt(cur.n) + '</span></button>' +
      cur.subs.map(function (s) {
        var label = s.name === cur.name ? escapeProvShort(cur.name) : s.name;
        return '<button class="chip' + (S.local === s.name ? ' on' : '') +
          '" type="button" data-local="' + esc(s.name) + '">' + esc(label) +
          '<span class="n">' + fmt(s.n) + '</span></button>';
      }).join('');
  }

  function escapeProvShort(name) {
    return name.replace(/(省|市|自治区|壮族|回族|维吾尔)/g, '') + '本级';
  }

  function setProv(p) {
    S.prov = p || '全部';
    S.local = '全部';
    if (S.prov !== '全部' && S.filter !== '地方法规') S.filter = '地方法规';
    if (S.prov !== '全部' && S.filter === '地方法规') S.filter = '地方法规';
    renderChips();
    renderRegionChips();
    renderLibrary(true);
  }

  function setLocal(l) {
    S.local = l || '全部';
    renderRegionChips();
    renderLibrary(true);
  }

  function renderRegionGrid() {
    var box = $('region-grid');
    if (!box) return;
    var list = regionTree().slice(0, 8);
    if (!list.length) { box.innerHTML = '<div class="empty">暂无地方法规</div>'; return; }
    box.innerHTML = list.map(function (r) {
      return '<button class="region-tile lg lg--tile lg-lens" type="button" data-prov="' + esc(r.name) + '" data-lg-lens>' +
        '<span class="rt-name">' + esc(r.name) + '</span>' +
        '<span class="rt-count">' + fmt(r.n) + ' 部 · ' + (r.subs.length - 1) + ' 市</span>' +
      '</button>';
    }).join('');
  }

  /* ---- 按地区浏览：两级菜单 ---- */
  function openRegionSheet() {
    showProvSheet();
  }

  function showProvSheet() {
    var tree = regionTree();
    var total = tree.reduce(function (a, t) { return a + t.n; }, 0);
    openSheet({
      kind: 'pick',
      title: '按地区浏览',
      note: '共 ' + fmt(total) + ' 部地方性法规 · ' + tree.length + ' 个省级行政区',
      value: S.prov,
      items: [{
        label: '全部地区', value: '__all',
        desc: fmt(total) + ' 部'
      }].concat(tree.map(function (t) {
        return {
          label: t.name, value: t.name,
          desc: fmt(t.n) + ' 部 · ' + (t.subs.length - 1) + ' 个市州',
          sub: true
        };
      })),
      onPick: function (v) {
        if (v === '__all') {
          setProv('全部');
          closeSheet();
          goto(1);
          toast('已显示全部地区');
          return;
        }
        showCitySheet(v);
      }
    });
  }

  function showCitySheet(prov) {
    var tree = regionTree();
    var cur = null;
    for (var i = 0; i < tree.length; i++) if (tree[i].name === prov) cur = tree[i];
    if (!cur) return;
    openSheet({
      kind: 'pick',
      title: prov,
      back: showProvSheet,
      note: '本级 ' + fmt(cur.subs[0].n) + ' 部 · 下辖 ' + (cur.subs.length - 1) + ' 个市州',
      value: S.prov === prov ? S.local : null,
      items: [{
        label: '全省（不细分）', value: '__all',
        desc: fmt(cur.n) + ' 部'
      }].concat(cur.subs.map(function (s) {
        return {
          label: s.name === prov ? prov + '（省本级）' : s.name,
          value: s.name,
          desc: fmt(s.n) + ' 部'
        };
      })),
      onPick: function (v) {
        S.prov = prov;
        S.local = v === '__all' ? '全部' : v;
        S.filter = '地方法规';
        renderChips();
        renderRegionChips();
        renderLibrary(true);
        closeSheet();
        goto(1);
        toast('已筛选：' + prov + (v === '__all' ? '' : ' · ' + (v === prov ? '省本级' : v)));
      }
    });
  }

  /* ============================ 随机 / 统计 / 历史 ============================ */
  function openRandomLaw() {
    if (!S.catalog.length) return;
    var pool = S.catalog.filter(function (d) { return (d.chars || 0) > 800; });
    if (!pool.length) pool = S.catalog;
    var pick = pool[Math.floor(Math.random() * pool.length)];
    openLaw(pick.bbbs);
    toast('随机一条 · ' + (pick.local || pick.flxz || ''));
  }

  function openStatsSheet() {
    var chars = S.catalog.reduce(function (a, b) { return a + (b.chars || 0); }, 0);
    var valid = S.catalog.filter(function (d) { return d.sxx === 3; }).length;
    var locals = S.catalog.filter(function (d) { return d.flxz === '地方法规'; });
    var tree = regionTree();
    var provN = tree.length;
    var cityN = tree.reduce(function (a, t) { return a + t.subs.length - 1; }, 0);
    var catNote = CATS.slice(1).map(function (c) {
      return c + ' ' + fmt(S.catalog.filter(function (d) { return d.flxz === c; }).length);
    }).join('　');
    openSheet({
      kind: 'info',
      title: '数据统计',
      head: { glyph: '数', name: 'LexiGlass · 离线库', sub: fmt(S.catalog.length) + ' 部 · ' + wan(chars) + ' 万字' },
      rows: [
        ['收录法规', fmt(S.catalog.length) + ' 部'],
        ['累计字数', fmt(chars) + ' 字'],
        ['现行有效', fmt(valid) + ' 部'],
        ['地方法规', fmt(locals.length) + ' 部'],
        ['覆盖地区', provN + ' 省级 · ' + cityN + ' 市州'],
        ['书签', S.fav.length + ' 条'],
        ['搜索历史', S.history.length + ' 条']
      ],
      note: '按分类：' + catNote + '。全文索引共 ' + fmt(chars) + ' 字，首次全文检索时在本机建立，约 3–6 秒。'
    });
  }

  function openHistorySheet() {
    if (!S.history.length) {
      openSheet({
        kind: 'info', title: '搜索历史',
        note: '还没有搜索记录。在法规库搜索过的关键词会自动留在这里，最多保留 12 条。'
      });
      return;
    }
    openSheet({
      kind: 'pick',
      title: '搜索历史',
      note: '点击可直接重新搜索',
      items: S.history.map(function (h) { return { label: h, value: h }; }),
      value: null,
      onPick: function (v) {
        closeSheet();
        goto(1);
        var q = $('q');
        if (q) { q.value = v; S.keyword = v; renderLibrary(true); }
      }
    });
  }

  function pushHistory(q) {
    if (!q) return;
    S.history = S.history.filter(function (x) { return x !== q; });
    S.history.unshift(q);
    S.history = S.history.slice(0, 12);
    save();
  }

  function copyDoc() {
    if (!S.cur) return;
    var txt = S.cur.title + '\n\n' + (S.curBlocks || []).map(function (b) {
      if (b.type === '条') return (b.no || '') + '　' + (b.text || '');
      return b.title || b.text || '';
    }).filter(Boolean).join('\n');
    try {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('已复制全文 ' + fmt(txt.length) + ' 字');
    } catch (e) {
      toast('复制失败');
    }
  }

  /* ============================ Dock ============================ */
  function setupDock() {
    var nav = document.getElementById('bottom-nav');
    dock = new GlassDock(nav, {
      panes: '.tab-pane',
      scrollMemory: false,
      onChange: function (index, id) {
        S.tab = id;
        window.scrollTo(0, 0);
        if (id === 'library') renderLibrary(false);
        if (id === 'fav') renderFav();
        if (id === 'home') { renderRecent(); renderCats(); }
        canBack(false);
      }
    });
  }

  function goto(index) { if (dock) dock.select(index); }

  /* ============================ 事件 ============================ */
  function bindEvents() {
    var nav = document.getElementById('bottom-nav');

    document.addEventListener('click', function (e) {
      var t = e.target;

      var open = t.closest('[data-open]');
      if (open) {
        var jb = open.getAttribute('data-blkjump');
        openLaw(open.getAttribute('data-open'), jb === null ? undefined : Number(jb));
        return;
      }

      var favBtn = t.closest('[data-fav]');
      if (favBtn) {
        e.stopPropagation();
        var id = favBtn.getAttribute('data-fav');
        var on = toggleFav(id);
        favBtn.classList.toggle('on', on);
        favBtn.closest('.law').classList.toggle('is-fav', on);
        return;
      }

      var quick = t.closest('[data-quick]');
      if (quick) { doMoreAct(quick.getAttribute('data-quick')); return; }

      var go = t.closest('[data-goto]');
      if (go) { goto(Number(go.getAttribute('data-goto'))); return; }

      var cat = t.closest('[data-cat]');
      if (cat) {
        S.filter = cat.getAttribute('data-cat');
        S.keyword = ''; var qi = $('q'); if (qi) qi.value = '';
        renderChips(); goto(1); renderLibrary(true);
        return;
      }

      var chip = t.closest('[data-chip]');
      if (chip) {
        S.filter = chip.getAttribute('data-chip');
        renderChips(); renderLibrary(true); return;
      }

      var blk = t.closest('[data-blk]');
      if (blk) { jumpBlock(Number(blk.getAttribute('data-blk'))); return; }
    });

    /* ---------- 更多菜单 ---------- */
    $('btn-more').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMore();
    });
    $('more-menu').addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('[data-act]') : null;
      if (item) doMoreAct(item.getAttribute('data-act'));
    });
    document.addEventListener('click', function (e) {
      if (!moreOpen()) return;
      if (e.target.closest && (e.target.closest('#more-menu') || e.target.closest('#btn-more'))) return;
      toggleMore(false);
    });

    /* ---------- 搜索范围 ---------- */
    $('search-mode').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.seg-btn') : null;
      if (btn) setSearchMode(btn.getAttribute('data-mode'));
    });

    /* ---------- 地区 chip（法规库，两级） ---------- */
    $('region-chips').addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-prov]') : null;
      if (c) setProv(c.getAttribute('data-prov'));
    });
    $('city-chips').addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-local]') : null;
      if (c) setLocal(c.getAttribute('data-local'));
    });

    /* ---------- 首页地区网格（省级，点进去看市州） ---------- */
    $('region-grid').addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-prov]') : null;
      if (!t) return;
      var r = t.getAttribute('data-prov');
      S.prov = r;
      S.local = '全部';
      S.filter = '地方法规';
      renderChips();
      renderRegionChips();
      renderLibrary(true);
      goto(1);
    });
    $('home-region-all').addEventListener('click', function () {
      S.prov = '全部';
      S.local = '全部';
      S.filter = '地方法规';
      renderChips();
      renderRegionChips();
      renderLibrary(true);
      goto(1);
    });

    /* ---------- 选项窗口返回 ---------- */
    $('opt-back').addEventListener('click', function () {
      var fn = $('opt-back')._fn;
      if (fn) fn();
    });

    /* ---------- 阅读页复制 ---------- */
    $('reader-copy').addEventListener('click', copyDoc);

    var q = $('q');
    var timer = null;
    q.addEventListener('input', function () {
      var v = q.value;
      $('q-clear').classList.toggle('on', !!v);
      clearTimeout(timer);
      var isFull = S.mode === 'full';
      // 全文模式要扫几百万字，防抖长一点，并且少于 2 字不搜
      if (isFull && v.trim().length < 2) {
        S.keyword = v.trim();
        renderLibrary(true);
        return;
      }
      timer = setTimeout(function () {
        S.keyword = v.trim();
        if (isFull) {
          if (S.keyword.length >= 2) {
            runFullSearch(S.keyword);
            pushHistory(S.keyword);
          } else {
            renderLibrary(true);
          }
        } else {
          renderLibrary(true);
        }
      }, isFull ? 420 : 120);
    });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        q.blur();
        S.keyword = q.value.trim();
        if (S.keyword) pushHistory(S.keyword);
        if (S.mode === 'full' && S.keyword.length >= 2) runFullSearch(S.keyword);
        else renderLibrary(true);
      }
    });
    q.addEventListener('focus', function () {
      if (S.mode === 'full' && (S.keyword || '').length >= 2) {
        if (FT.q !== S.keyword.trim() || FT.state !== 'ready') runFullSearch(S.keyword.trim());
      }
    });
    $('q-clear').addEventListener('click', function () {
      q.value = ''; S.keyword = ''; $('q-clear').classList.remove('on');
      renderLibrary(true); q.focus();
    });
    $('load-more').addEventListener('click', function () { S.page++; renderLibrary(false); });

    $('reader-back').addEventListener('click', closeReader);
    $('reader-fav').addEventListener('click', function () {
      if (!S.curNode) return;
      var on = toggleFav(S.curNode);
      updateFavIcon(S.curNode);
      var cards = document.querySelectorAll('.law[data-id="' + S.curNode + '"]');
      for (var i = 0; i < cards.length; i++) {
        cards[i].classList.toggle('is-fav', on);
        var b = cards[i].querySelector('.law-fav');
        if (b) b.classList.toggle('on', on);
      }
    });
    $('reader-toc').addEventListener('click', openToc);
    $('toc-close').addEventListener('click', closeToc);
    $('toc-mask').addEventListener('click', function (e) { if (e.target === $('toc-mask')) closeToc(); });

    var dq = $('dq');
    dq.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); dq.blur(); docSearch(dq.value); }
    });

    $('row-theme').addEventListener('click', openThemeSheet);
    $('row-lfont').addEventListener('click', function () { openFontSheet('list'); });
    $('row-bfont').addEventListener('click', function () { openFontSheet('body'); });
    $('row-immersive').addEventListener('click', openImmersiveSheet);
    $('row-offline').addEventListener('click', openOfflineSheet);
    $('row-favclear').addEventListener('click', openClearFavConfirm);
    $('row-source').addEventListener('click', openSourceSheet);
    $('row-about').addEventListener('click', openAboutSheet);

    // 选项窗口交互
    $('opt-close').addEventListener('click', closeSheet);
    $('opt-cancel').addEventListener('click', closeSheet);
    $('opt-ok').addEventListener('click', function () {
      var fn = SHEET.onOk;
      closeSheet();
      if (fn) fn();
    });
    $('opt-mask').addEventListener('click', function (e) { if (e.target === $('opt-mask')) closeSheet(); });
    $('opt-body').addEventListener('click', function (e) {
      var t = e.target;
      var link = t.closest ? t.closest('#opt-link') : null;
      if (link) {
        var u = link.getAttribute('data-url');
        if (u) openUrl(u);
        return;
      }
      var item = t.closest ? t.closest('.opt-item') : null;
      if (item && SHEET.kind === 'pick') pickInSheet(item.getAttribute('data-val'));
    });

    // 安卓返回键
    window.appBack = function () {
      if (!$('opt-mask').hidden) { closeSheet(); return true; }
      if (!$('toc-mask').hidden) { closeToc(); return true; }
      if ($('reader').classList.contains('on')) { closeReader(); return true; }
      if (S.tab !== 'home') { goto(0); return true; }
      return false;
    };


    // 键盘：Esc 关闭弹窗 / 阅读页
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('opt-mask').hidden) closeSheet();
        else if (!$('toc-mask').hidden) closeToc();
        else if ($('reader').classList.contains('on')) closeReader();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
