/* ============================================================
 * render.js — 《魔兽世界4AC》可视化渲染 + 回放控制
 * ------------------------------------------------------------
 * 职责:
 *  1. 加载内嵌/自定义 .in + .out → parser → engine → 快照流
 *  2. Canvas 画战场(红/蓝司令部 + n 座城,顶部方向箭头)
 *  3. DOM 单位节点(兵种 emoji + 血条 + 武器徽章 + 士气/忠诚)
 *  4. 事件日志侧栏(滚动跟随 + 过滤)
 *  5. 播放/暂停/步进/调速/进度/计时
 * ============================================================ */
(function () {
  'use strict';

  /* ------- 常量 ------- */
  const KIND_EMOJI = { dragon: '🐉', ninja: '🥷', iceman: '🧊', lion: '🦁', wolf: '🐺' };
  const WEAPON_ICON = { sword: '🗡', bomb: '💣', arrow: '🏹' };

  /* ------- 全局状态 ------- */
  const app = {
    cases: [],        // parser 产物
    runs: [],         // engine 产物(runs[i] 与 cases[i] 对应)
    casIdx: 0,
    snapIdx: 0,       // 当前快照索引(快照含时间标签)
    playing: false,
    speed: 1,
    timer: null,
    filterRe: null,
    els: {},
  };

  /* ------- DOM 引用 ------- */
  function $(id) { return document.getElementById(id); }
  app.els = {
    canvas: $('scene'), wrap: $('scene-wrap'),
    caseSelect: $('case-select'), btnPlay: $('btn-play'), btnStep: $('btn-step'),
    btnPrev: $('btn-prev'), btnRestart: $('btn-restart'), btnEnd: $('btn-end'),
    speedSelect: $('speed-select'), seek: $('seekbar'), time: $('time-readout'),
    log: $('log-list'), logHead: $('log-head'), logSearch: $('log-search'),
    caseInfo: $('case-info'), radarCase: $('radar-case'), score: $('score'),
    fileInput: $('file-input'), btnOpen: $('btn-open'), tooltip: $('tooltip'),
  };

  /* ---------------- 数据加载 ---------------- */
  async function loadDefault() {
    // 优先内嵌样例(免 fetch / file:// 限制)
    if (typeof EMBEDDED_SAMPLE !== 'undefined') {
      ingest(EMBEDDED_SAMPLE.input, EMBEDDED_SAMPLE.output);
      return;
    }
    try {
      const [inTxt, outTxt] = await Promise.all([
        fetch('data/Warcraft.in').then(r => r.text()),
        fetch('data/Warcraft.out').then(r => r.text()),
      ]);
      ingest(inTxt, outTxt);
    } catch (e) {
      $('case-info').textContent = '未找到 data 目录,请用 📂 打开数据 ';
      console.error(e);
    }
  }

  function ingest(inTxt, outTxt) {
    if (!outTxt.trim()) { alert('日志(out)为空'); return; }
    const cases = globalThis.WarcraftParser.parse(inTxt || '', outTxt);
    if (!cases.length) { alert('无法解析日志'); return; }
    app.cases = cases;
    app.runs = cases.map(c => globalThis.WarcraftEngine.buildCase(c));
    // 案例下拉
    const sel = app.els.caseSelect;
    sel.options.length = 0;
    cases.forEach((c, i) => {
      const opt = document.createElement('option');
      const n = c.config ? c.config.n : '(推断)' ;
      const m = c.config ? c.config.m : '-';
      opt.value = i;
      opt.textContent = `Case ${c.index}  (城×${n}, 生命元${m})`;
      sel.appendChild(opt);
    });
    app.casIdx = 0;
    sel.value = 0;
    setCase(0);
    updateRadar();
  }

  /* ---------------- 时间格式 ---------------- */
  function fmtMin(m) {
    const h = String(Math.floor(m / 60)).padStart(3, '0');
    const mm = String(m % 60).padStart(2, '0');
    return `${h}:${mm}`;
  }

  /* ---------------- 切换案例 ---------------- */
  function setCase(i) {
    app.casIdx = i;
    app.filterRe = null;
    app.els.logSearch.value = '';
    // 初始自动推进到"第一个 00:00 出生完成"之后的快照,让出生动画立刻可见
    const run = app.runs[i];
    let start = 0;
    if (run) {
      let found = 0;
      for (let s = 0; s < run.snapshots.length; s++) {
        if (run.snapshots[s].minute === 0 && Object.keys(run.snapshots[s].units).length > found) {
          start = s; found = Object.keys(run.snapshots[s].units).length;
        } else if (run.snapshots[s].minute !== 0) break;
      }
    }
    app.snapIdx = start;
    renderSnap(start);
    renderLog(-1);
    app.els.caseInfo.innerHTML = caseInfoHtml(i);
    updateRadar();
    updateSeek();
    stopAuto();
  }

  function caseInfoHtml(i) {
    const c = app.cases[i];
    const cfg = c.config;
    const parts = [];
    if (cfg) {
      parts.push(`m=${cfg.m} <b>n=${cfg.n}</b> r=${cfg.r} k=${cfg.k} T=${cfg.T}`);
      parts.push(`生命值 [${cfg.life.join(',')}]`);
      parts.push(`攻击力 [${cfg.force.join(',')}]`);
    } else {
      parts.push(`n=${app.runs[i].n} (自日志推断)`);
    }
    parts.push(`事件 ${c.events.length} 条`);
    return parts.join(' · ');
  }

  /* ---------------- 渲染: Canvas 战场底图 ---------------- */
  function renderCanvas() {
    const cv = app.els.canvas, ctx = cv.getContext('2d');
    const L = layout();
    const w = app.els.wrap.clientWidth;
    const h = Math.max(app.els.wrap.clientHeight, L.totalH); // 高度随行数自适应,多行时可滚动
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const run = app.runs[app.casIdx];
    if (!run) return;
    const snap = app.runs[app.casIdx].snapshots[app.snapIdx];
    const n = run.n;
    const slots = n + 2;
    const slotW = L.slotW, roadH = L.roadH;

    // 每行一条行军队列 + 方向箭头
    for (let r = 0; r < L.rows; r++) {
      const pathY = L.pathYFor(r);
      const isLastRow = r === L.rows - 1;
      // 虚线道路
      ctx.strokeStyle = '#2c313d';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(0, pathY); ctx.lineTo(w, pathY);
      ctx.stroke();
      ctx.setLineDash([]);
      // 行方向提示(第一行红从左往右,最后一行蓝从右往左;中间行按所在行两端)
      ctx.fillStyle = '#3d4453';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      const rowStart = L.rowCols[r][0], rowEnd = L.rowCols[r][1];
      const hasRed = rowStart === 0;
      const hasBlue = rowEnd === slots - 1;
      if (hasRed) ctx.fillText('红方出击 →', slotW * 0.5, pathY - roadH / 2 - 24);
      if (hasBlue) ctx.fillText('← 蓝方出击', w - slotW * 0.5, pathY - roadH / 2 - 24);
      else ctx.fillText('→ 进军方向', w - slotW * 0.5, pathY - roadH / 2 - 24);
    }

    for (let s = 0; s < slots; s++) {
      const { x, row } = L.pos(s);
      const pathY = L.pathYFor(row);
      const isHq = s === 0 || s === slots - 1;
      // 地块
      ctx.fillStyle = isHq ? '#24181c' : (s % 2 ? '#191c25' : '#1b1e28');
      roundRect(ctx, x - slotW / 2 + 6, pathY - roadH / 2, slotW - 12, roadH, 10);
      // 边框
      ctx.strokeStyle = isHq ? '#5a1f24' : '#2b3039';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 顶部小字(普通城: 城号; 司令部: 名)
      ctx.fillStyle = isHq ? '#d0a05a' : '#8d94a3';
      ctx.font = 'bold 12px sans-serif';
      if (!isHq) ctx.fillText('城' + s, x, pathY - roadH / 2 - 8);
      else ctx.fillText(s === 0 ? '红方营地' : '蓝方营地', x, pathY - roadH / 2 - 8);

      // 旗帜与元素(普通城)
      if (!isHq && snap) {
        const c = snap.city[s];
        // 旗帜
        if (c && c.flag) {
          ctx.fillStyle = c.flag === 1 ? '#ff6b6b' : '#6fa3ff';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('⚑', x, pathY - roadH / 2 - 24);
        }
        // 元素值
        if (c && c.element) {
          ctx.fillStyle = '#7ad0a0';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText('◆' + c.element, x + slotW * 0.3, pathY + roadH / 2 + 14);
        }
      }
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- 坐标布局(支持多行折行) ---------------- */
  const MAX_PER_ROW = 12;   // 每行最多格子数;多余则折到下一行
  function layout() {
    const cv = app.els.canvas;
    const w = cv.clientWidth, h = cv.clientHeight;
    const run = app.runs[app.casIdx];
    if (!run) return { slotW: 0, roadH: 26, rows: 1, pos: () => ({ x: 0, y: 0 }), rowTopY: () => 0, pathFor: () => 0 };
    const n = run.n, slots = n + 2;

    // 折行安排: 每行开头放最后一个没放下的格子
    const rowCols = [];
    let i = 0;
    while (i < slots) {
      const take = Math.min(MAX_PER_ROW, slots - i);
      rowCols.push([i, i + take - 1]);
      i += take;
    }
    const rows = rowCols.length;
    const colsInRow = Math.max(...rowCols.map(([a, b]) => b - a + 1));
    const slotW = w / colsInRow;

    // 纵向布局: 顶栏 34px,一行道路高,行间距
    const topPad = 34;
    const roadH = Math.max(26, h * 0.045);
    const rowGap = 64 + roadH;             // 两行车之间的垂直间距(含单位与信息)
    // 行归属
    const rowOf = (s) => { for (let r = 0; r < rowCols.length; r++) { const [a, b] = rowCols[r]; if (s >= a && s <= b) return r; } return 0; };
    const pathYFor = (r) => topPad + roadH / 2 + r * rowGap;
    const xInRow = (s) => {
      for (let r = 0; r < rowCols.length; r++) { const [a, b] = rowCols[r]; if (s >= a && s <= b) return (s - a + 0.5) * slotW; }
      return slotW * 0.5;
    };
    const pos = (s) => {
      const r = rowOf(s);
      return { x: xInRow(s), row: r, y: pathYFor(r) };
    };
    const totalH = topPad + roadH / 2 + (rows - 1) * rowGap + roadH / 2 + 30;
    return { slotW, roadH, rows, rowCols, topPad, rowGap, pathYFor, xInRow, pos, totalH };
  }

  /* ---------------- 渲染: 一张快照 ---------------- */
  function renderSnap(snapIdx) {
    const run = app.runs[app.casIdx];
    const snap = run.snapshots[snapIdx];
    if (!snap) return;
    // 与上一快照对比,得出“刚出生/刚死亡/刚移动”的集合,供动画使用
    const prev = snapIdx > 0 ? run.snapshots[snapIdx - 1] : null;
    const anim = diffSnap(prev, snap);
    renderCanvas();

    // 重绘单位节点
    rebuildUnits(snap, run, anim);
    // 司令部生命元
    renderHQ(snap, run);
    // 时间
    app.els.time.textContent = fmtMin(snap.minute);
    // 场景顶部中央时钟
    let clock = app.els.wrap.querySelector('#clock');
    if (!clock) {
      clock = document.createElement('div');
      clock.id = 'clock';
      app.els.wrap.appendChild(clock);
    }
    clock.textContent = fmtMin(snap.minute);
  }

  /* 计算快照间动画集合 */
  function diffSnap(prev, snap) {
    const born = new Set(), dead = new Set(), moved = new Set(), hqChg = new Set();
    if (!prev) return { born, dead, moved, hqChg };
    for (const k of Object.keys(snap.units)) {
      const u = snap.units[k], pu = prev.units[k];
      if (!pu) { born.add(k); continue; }
      if (!u.alive && pu.alive) { dead.add(k); continue; }
      if (u.alive) {
        const pPos = (pu.inHQ || pu.city) ?? '';
        const nPos = (u.inHQ || u.city) ?? '';
        if (pPos !== nPos) moved.add(k);
      }
    }
    for (const k of Object.keys(prev.units)) if (!snap.units[k]) dead.add(k);
    if (prev.hq.red.life !== snap.hq.red.life) hqChg.add('red');
    if (prev.hq.blue.life !== snap.hq.blue.life) hqChg.add('blue');
    return { born, dead, moved, hqChg };
  }

  /* 武器文字标签(图标 + 名称/数值) */
  function weaponLabel(u) {
    const wpnTxt = {
      sword: (p) => `剑${p != null ? '(' + p + ')' : ''}`,
      bomb: () => '炸弹',
      arrow: (p) => `箭${p != null ? '(' + p + ')' : ''}`,
    };
    let html = '';
    if (u.weapons && u.weapons.length) {
      u.weapons.forEach(w => {
        const lbl = wpnTxt[w.name] ? wpnTxt[w.name](w.param) : (w.name || '?');
        html += `<span>${WEAPON_ICON[w.name] || ''}${lbl}</span>`;
      });
    } else {
      html = '<span class="nowpn">无武器</span>';
    }
    return html;
  }
  function updSubfield(el, sel, text) {
    let node = el.querySelector(sel);
    if (text == null) { if (node) node.remove(); return; }
    if (!node) {
      node = document.createElement('div');
      node.className = sel.slice(1);
      el.appendChild(node);
    }
    node.textContent = text;
  }

  /* 单位节点: 按 ukey 做 DOM 调和(保留节点 → CSS 过渡滑行;新增 → spawn;消失 → 淡出) */
  function rebuildUnits(snap, run, anim) {
    const wrap = app.els.wrap;
    const lay = layout();
    const n = run.n;

    // 1. 计算每个存活单位的期望位置
    const wantPos = new Map(); // ukey -> {x, y}
    const aliveKeys = new Set();
    const unitsAt = {}; // posKey -> [ukey]  (用于同格错开)
    for (const key of Object.keys(snap.units)) {
      const u = snap.units[key];
      if (!u || !u.alive) continue;
      let pos;
      if (u.inHQ) pos = u.inHQ === 'red' ? 'hqR' : 'hqB';
      else if (u.city != null) pos = 'city' + u.city;
      else continue;
      aliveKeys.add(key);
      (unitsAt[pos] = unitsAt[pos] || []).push(key);
    }

    // 2. 计算坐标(同格错开)
    for (const pos of Object.keys(unitsAt)) {
      const slot = pos === 'hqR' ? 0 : pos === 'hqB' ? n + 1 : +pos.slice(4);
      const isHQ = pos === 'hqR' || pos === 'hqB';
      const P = lay.pos(slot);
      const baseY = isHQ ? P.y - lay.roadH + 14 : P.y;
      const list = unitsAt[pos];
      list.forEach((key, idx) => {
        const off = (idx - (list.length - 1) / 2) * 28;
        wantPos.set(key, { x: P.x + off, y: baseY });
      });
    }

    // 3. 调和: 遍历现有节点
    const nodes = wrap.querySelectorAll('.unit-node');
    const used = new Set();
    for (const el of nodes) {
      const key = el.dataset.key;
      if (!key) continue;
      if (wantPos.has(key)) {
        // 存活: 更新坐标(若有 CSS 过渡即平滑滑行)
        const p = wantPos.get(key);
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        el.classList.remove('dead');
        // 更新血条 + 武器 + 士气/忠诚(动态字段可能已变化)
        const u = snap.units[key];
        const fill = el.querySelector('.hpbar i');
        if (fill && u.hp != null) {
          fill.style.width = Math.max(0, Math.min(100, u.hp)) + '%';
        }
        const ws = weaponLabel(u);
        el.querySelector('.weapons').innerHTML = ws;
        updSubfield(el, '.morale', u.kind === 'dragon' && u.morale != null ? '士气 ' + u.morale.toFixed(2) : null);
        updSubfield(el, '.loyalty', u.kind === 'lion' && u.loyalty != null ? '忠诚 ' + u.loyalty : null);
        used.add(key);
      } else {
        // 消失: 直接移除节点(不留尸体累积;特效在上面的 playEffects 已呈现)
        el.remove();
      }
    }

    // 4. 新增节点
    for (const key of aliveKeys) {
      if (used.has(key)) continue;
      const u = snap.units[key];
      const p = wantPos.get(key);
      if (!p) continue;
      const el = document.createElement('div');
      el.className = 'unit-node';
      if (anim && anim.born.has(key)) el.classList.add('spawn');
      const isHQ = u.inHQ != null;
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';

      // 阵营色相偏置
      el.style.filter = `saturate(${u.side === 'red' ? 1.1 : 0.95})`;

      // 底色圆
      const circle = document.createElement('div');
      circle.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-65%);width:40px;height:40px;border-radius:50%;
        background:radial-gradient(circle at 36% 32%, ${u.side === 'red' ? 'rgba(255,90,90,.35)' : 'rgba(90,140,255,.35)'}, ${u.side === 'red' ? '#5c1620' : '#13264f'});
        border:2px solid ${u.side === 'red' ? '#ff6b6b' : '#6fa3ff'};
        box-shadow:0 0 12px ${u.side === 'red' ? 'rgba(224,57,62,.5)' : 'rgba(47,111,208,.5)'};
        z-index:1;`;
      el.appendChild(circle);

      const em = document.createElement('div');
      em.className = 'emoji';
      em.textContent = KIND_EMOJI[u.kind] || '🐾';
      em.style.position = 'relative'; em.style.zIndex = '2'; em.style.marginTop = '6px';
      el.appendChild(em);

      // 血条
      const bar = document.createElement('div');
      bar.className = 'hpbar';
      bar.style.width = '84%'; bar.style.margin = '2px auto 0';
      const fill = document.createElement('i');
      const hp = u.hp;
      const pct = hp != null ? Math.max(0, Math.min(100, hp)) : 100;
      fill.style.width = pct + '%';
      fill.style.background = u.side === 'red' ? '#ff6161' : '#63a4ff';
      bar.appendChild(fill);
      el.appendChild(bar);

      // 标签
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = `${u.kind}${u.no}`;
      el.appendChild(tag);

      // 武器徽章(图标 + 文字,注明武器名与数值)
      const wbox = document.createElement('div');
      wbox.className = 'weapons';
      wbox.innerHTML = weaponLabel(u);
      el.appendChild(wbox);
      // 士气 / 忠诚
      updSubfield(el, '.morale', u.kind === 'dragon' && u.morale != null ? '士气 ' + u.morale.toFixed(2) : null);
      updSubfield(el, '.loyalty', u.kind === 'lion' && u.loyalty != null ? '忠诚 ' + u.loyalty : null);

      // 挂载 & 事件
      el.dataset.key = key;
      el.addEventListener('mouseenter', (e) => showTooltip(e, u));
      el.addEventListener('mousemove', moveTooltip);
      el.addEventListener('mouseleave', hideTooltip);
      wrap.appendChild(el);
    }
  }

  /* 司令部面板: 生命元 + 占领 */
  function renderHQ(snap, run) {
    // 用 DOM 覆盖层(画在 canvas 上方)
    const wrap = app.els.wrap;
    wrap.querySelectorAll('.hq-panel').forEach(e => e.remove());
    const lay = layout();
    const n = run.n;

    const mkPanel = (side, slot, life, occ) => {
      const el = document.createElement('div');
      el.className = 'hq-panel';
      el.style.cssText = `position:absolute;left:${lay.pos(slot).x}px;top:${lay.pathYFor(lay.pos(slot).row) - lay.roadH/2 - 66}px;transform:translateX(-50%);
        width:110px;text-align:center;font-size:12px;pointer-events:none;z-index:2;`;
      const title = document.createElement('div');
      title.textContent = (side === 'red' ? '🔴 红方司令部' : '🔵 蓝方司令部');
      title.style.fontWeight = '700';
      const lifeEl = document.createElement('div');
      lifeEl.style.color = 'var(--gold)';
      lifeEl.textContent = `⚡ ${life} 生命元`;
      el.appendChild(title); el.appendChild(lifeEl);
      if (occ) {
        const o = document.createElement('div');
        o.style.color = side === 'red' ? '#7fb0ff' : '#ff7b7f';
        o.textContent = `!! 被${side === 'red' ? '蓝' : '红'}方占领`;
        el.appendChild(o);
      }
      wrap.appendChild(el);
    };

    const hqR = snap.hq.red, hqB = snap.hq.blue;
    mkPanel('red', 0, hqR.life, hqR.occupier || hqR.taken ? 'taken' : null);
    mkPanel('blue', n + 1, hqB.life, hqB.occupier || hqB.taken ? 'taken' : null);
  }

  /* ---------------- 日志 ---------------- */
  function eventText(ev) {
    switch (ev.type) {
      case 'born': return `${ev.side} ${ev.kind} ${ev.no} 出生`;
      case 'moraleLine': return `　士气 ${ev.value.toFixed(2)}`;
      case 'loyaltyLine': return `　忠诚 ${ev.value}`;
      case 'lionRunaway': return `${ev.side} 狮子 ${ev.no} 逃跑`;
      case 'march': return `${ev.side} ${ev.kind} ${ev.no} 进军 → 城${ev.city}`;
      case 'reachHQ': return `${ev.side} ${ev.kind} ${ev.no} 冲入${ev.target === 'red' ? '红' : '蓝'}方司令部！`;
      case 'hqTaken': return `❗ ${ev.side}方司令部被占领 —— 战斗结束`;
      case 'earn': return `${ev.side} ${ev.kind} ${ev.no} 为主营夺得 ${ev.amount} 生命元`;
      case 'arrow': return `${ev.side} ${ev.kind} ${ev.no} 放箭`;
      case 'arrowKill': return `${ev.side} ${ev.kind} ${ev.no} 一箭射杀 ${ev.vSide} ${ev.vKind} ${ev.vNo}`;
      case 'bomb': return `${ev.side} ${ev.kind} ${ev.no} 引爆${ev.vSide} ${ev.vKind} ${ev.vNo}同归于尽`;
      case 'attacked': return `${ev.side} ${ev.kind} ${ev.no} 攻击${ev.vSide} ${ev.vKind} ${ev.vNo} @ 城${ev.city}`;
      case 'fightback': return `${ev.side} ${ev.kind} ${ev.no} 反击 ${ev.vSide} ${ev.vKind} ${ev.vNo}`;
      case 'killed': return `${ev.side} ${ev.kind} ${ev.no} 阵亡 @ 城${ev.city}`;
      case 'yell': return `🐉 士气高涨! ${ev.side} dragon ${ev.no} 在城${ev.city}怒吼`;
      case 'flagRaised': return `🚩 ${ev.side}旗在 城${ev.city} 升起`;
      case 'hqLife': return `${ev.side}方司令部现有 ${ev.value} 生命元`;
      case 'reportWpn': {
        const ws = ev.weapons.length
          ? ev.weapons.map(w => `${w.name}${w.param != null ? '(' + w.param + ')' : ''}`).join(',')
          : '无武器';
        return `${ev.side} ${ev.kind} ${ev.no} 持有 [${ws}]`;
      }
      default: return JSON.stringify(ev);
    }
  }
  function eventCls(ev) {
    if (ev.type === 'hqTaken') return 'sys';
    if (ev.type === 'hqLife') return 'dim';
    if (ev.type === 'moraleLine' || ev.type === 'loyaltyLine') return 'dim';
    return ev.side || '';
  }

  function renderLog(target) {
    // 从当前事件中抽取与快照对应的语句
    const caseData = app.cases[app.casIdx];
    const el = app.els.log;
    // 依据 snap 时间过滤
    const snap = app.runs[app.casIdx].snapshots[Math.max(0, app.snapIdx)];
    el.innerHTML = '';
    const frag = document.createDocumentFragment();
    const maxLines = Math.min(180, caseData.events.length);
    const shown = [];
    let count = 0;
    // 倒序取最近的事件
    for (let i = caseData.events.length - 1; i >= 0 && count < maxLines; i--) {
      const ev = caseData.events[i];
      if (ev.t < 0) continue;
      if (ev.t > snap.minute) continue;
      if (app.filterRe && !app.filterRe.test(eventText(ev))) continue;
      shown.push(ev);
      count++;
    }
    shown.reverse();
    for (const ev of shown) {
      const div = document.createElement('div');
      div.className = 'ev ' + eventCls(ev);
      const st = document.createElement('span');
      st.className = 'evStamp';
      st.textContent = (ev.t >= 0 ? fmtMin(ev.t) : '──') + ' ';
      div.appendChild(st);
      div.appendChild(document.createTextNode(eventText(ev)));
      frag.appendChild(div);
    }
    el.appendChild(frag);
    // 滚动到底
    el.scrollTop = el.scrollHeight;
  }

  /* ---------------- 工具提示 ---------------- */
  function showTooltip(e, u) {
    const tip = app.els.tooltip;
    tip.style.display = 'block';
    let html = `<div class="tl-name" style="color:${u.side === 'red' ? '#ff7b7f' : '#7fb0ff'}">` +
      `${u.side === 'red' ? '🔴' : '🔵'} ${u.kind}${u.no}</div>`;
    html += `<div class="tl-hp">HP ${u.hp ?? '未知'} ｜ 攻击 ${u.force ?? '未知'}</div>`;
    if (u.weapons && u.weapons.length) html += `<div>武器: ${u.weapons.map(w => w.name + (w.param != null ? `(${w.param})` : '')).join('、')}</div>`;
    else html += '<div>武器: 无</div>';
    if (u.kind === 'dragon' && u.morale != null) html += `<div>士气: ${u.morale.toFixed(2)}</div>`;
    if (u.kind === 'lion' && u.loyalty != null) html += `<div>忠诚: ${u.loyalty}</div>`;
    html += `<div style="color:var(--muted)">位于 营地/城 ${u.city ?? u.inHQ}</div>`;
    tip.innerHTML = html;
    moveTooltip(e);
  }
  function moveTooltip(e) {
    const tip = app.els.tooltip;
    const pad = 12;
    let x = e.clientX + 14, y = e.clientY + 10;
    const r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 10;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTooltip() { app.els.tooltip.style.display = 'none'; }

  /* ---------------- 动画特效(依赖事件) ---------------- */
  function playEffects(events, snapMinute) {
    // 展示最近一分钟内发生的事件特效(仅视觉,不阻塞)
    const wrap = app.els.wrap;
    const lay = layout();
    const min = snapMinute;
    const atCity = (city) => ({ x: lay.pos(city).x, y: lay.pathYFor(lay.pos(city).row) });
    const float = (city, text, cls) => {
      if (city == null) return;
      const { x, y } = atCity(city);
      const el = document.createElement('div');
      el.className = 'eff-float ' + (cls || '');
      el.textContent = text;
      el.style.left = x + 'px'; el.style.top = (y - 24) + 'px';
      wrap.appendChild(el);
      setTimeout(() => el.remove(), 1150);
    };
    for (const ev of events) {
      if (ev.t !== min) continue;
      if (ev.type === 'bomb' || ev.type === 'arrowKill') {
        const city = ev.city != null ? ev.city : findCityFor(ev);
        if (city == null) continue;
        const { x, y } = atCity(city);
        const boom = document.createElement('div');
        boom.className = 'eff-boom';
        boom.style.left = x + 'px'; boom.style.top = y + 'px';
        wrap.appendChild(boom);
        setTimeout(() => boom.remove(), 600);
        float(city, ev.type === 'bomb' ? '💥 同归于尽' : '☠ 中箭身亡', 'death');
      } else if (ev.type === 'attacked') {
        const { x, y } = atCity(ev.city || findCityFor(ev) || 1);
        const slash = document.createElement('div');
        slash.className = 'eff-boom';
        slash.style.left = x + 'px'; slash.style.top = y + 'px';
        slash.style.background = 'radial-gradient(circle, rgba(255,255,255,.9), rgba(255,220,120,.4) 50%, transparent 75%)';
        slash.style.width = '28px'; slash.style.height = '28px';
        wrap.appendChild(slash);
        setTimeout(() => slash.remove(), 400);
      } else if (ev.type === 'earn') {
        float(ev.city != null ? ev.city : app.runs[app.casIdx].snapshots[app.snapIdx].units[ev.unitKey]?.city,
              '＋' + ev.amount + ' 生命元', '');
      } else if (ev.type === 'flagRaised') {
        float(ev.city, ev.side === 'red' ? '🚩红旗' : '🚩蓝旗', 'flag');
      } else if (ev.type === 'killed') {
        float(ev.city, '✝ 阵亡', 'death');
      } else if (ev.type === 'lionRunaway') {
        float(findCityFor(ev), '🦁 狮子逃跑', '');
      } else if (ev.type === 'hqTaken') {
        float(app.runs[app.casIdx].n + (ev.side === 'red' ? 1 : 0), '🏳 司令部被占!', 'death');
      }
    }
  }
  function findCityFor(ev) {
    // 优先从受害者当前城定位;若已在司令部则取相邻城;否则遍历全图找任意城
    const run = app.runs[app.casIdx];
    const snap = run.snapshots[app.snapIdx];
    const at = (uk) => { const u = uk && snap.units[uk]; return u; };
    for (const uk of [ev.vUnitKey, ev.unitKey]) {
      const u = at(uk);
      if (!u) continue;
      if (u.city != null) return u.city;
      if (u.inHQ) return u.side === 'red' ? 1 : run.n;
    }
    // 兜底: 找当前画面里任一单位所在城
    for (const k of Object.keys(snap.units)) {
      const u = snap.units[k];
      if (u && u.alive && u.city != null) return u.city;
    }
    return null;
  }

  /* ---------------- 回放控制 ---------------- */
  function updateSeek() {
    const run = app.runs[app.casIdx];
    if (!run) return;
    const max = run.snapshots.length - 1;
    app.els.seek.max = max;
    app.els.seek.value = app.snapIdx;
  }
  function updateRadar() {
    const c = app.cases[app.casIdx];
    app.els.radarCase.textContent = c ? `#${c.index}` : '?';
  }

  function tick() {
    const run = app.runs[app.casIdx];
    if (!run) return;
    // 基础: 每个动画节拍推进 1 帧快照;速度倍率越大步距越大
    const dt = Math.max(1, Math.round(app.speed));
    let next = Math.min(app.snapIdx + dt, run.snapshots.length - 1);
    stepTo(next);
    if (next >= run.snapshots.length - 1) {
      stopAuto();
      return;
    }
    scheduleNext();
  }
  function scheduleNext() {
    if (!app.playing) return;
    const ms = Math.max(30, 90 / app.speed); // 每帧间隔;高倍率步距大、间隔短 → 更流畅
    setTimeout(() => tick(), ms);
  }
  function stepTo(i) {
    const run = app.runs[app.casIdx];
    if (!run) return;
    i = Math.max(0, Math.min(run.snapshots.length - 1, Math.round(i)));
    app.snapIdx = i;
    renderSnap(i);
    renderLog(i);
    // 特效: 找出该分钟事件
    const snap = run.snapshots[i];
    const events = app.cases[app.casIdx].events.filter(e => e.t === snap.minute);
    playEffects(events, snap.minute);
    updateSeek();
  }

  function togglePlay() {
    if (!app.cases.length) return;
    app.playing = !app.playing;
    app.els.btnPlay.textContent = app.playing ? '⏸ 暂停' : '▶ 播放';
    if (app.playing) scheduleNext();
  }
  function stopAuto() {
    app.playing = false;
    app.els.btnPlay.textContent = '▶ 播放';
  }

  function nextStep() { stopAuto(); stepTo(Math.min(app.snapIdx + 1, app.runs[app.casIdx].snapshots.length - 1)); }
  function prevStep() { stopAuto(); stepTo(Math.max(app.snapIdx - 1, 0)); }
  function restart() { stopAuto(); stepTo(0); }
  function goEnd() { stopAuto(); stepTo(app.runs[app.casIdx].snapshots.length - 1); }

  /* ---------------- 打开本地文件 ---------------- */
  function handleFiles(files) {
    const arr = Array.from(files || []);
    const inF = arr.find(f => /\.(in|input)$/i.test(f.name));
    const outF = arr.find(f => /\.(out|output|txt|log)$/i.test(f.name));
    if (!outF) { alert('需要包含 .out（输出日志）文件'); return; }
    const rd = f => f.text();
    Promise.all([inF ? rd(inF) : Promise.resolve(''), rd(outF)])
      .then(([it, ot]) => ingest(it, ot))
      .catch(e => alert('读取出错: ' + e.message));
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    const E = app.els;
    E.btnPlay.addEventListener('click', togglePlay);
    E.btnStep.addEventListener('click', nextStep);
    E.btnPrev.addEventListener('click', prevStep);
    E.btnRestart.addEventListener('click', restart);
    E.btnEnd.addEventListener('click', goEnd);
    E.speedSelect.addEventListener('change', () => { app.speed = +E.speedSelect.value; });
    E.seek.addEventListener('input', () => {
      stopAuto();
      stepTo(+E.seek.value);
    });
    E.caseSelect.addEventListener('change', () => {
      setCase(+E.caseSelect.value);
    });
    E.logSearch.addEventListener('input', () => {
      const v = E.logSearch.value.trim();
      app.filterRe = v ? new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
      renderLog(app.snapIdx);
    });
    E.btnOpen.addEventListener('click', () => E.fileInput.click());
    E.fileInput.addEventListener('change', () => { handleFiles(E.fileInput.files); E.fileInput.value = ''; });

    window.addEventListener('resize', () => { renderSnap(app.snapIdx); });
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'ArrowRight') nextStep();
      else if (e.code === 'ArrowLeft') prevStep();
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bind();
    loadDefault();
    // 无头测试用: URL 带 #autoplay 时自动开始播放; #case=N 初始切换到案例 N
    if (location.hash.indexOf('autoplay') >= 0) {
      window.addEventListener('load', () => setTimeout(togglePlay, 400));
    }
    const cm = /#case=(\d+)/.exec(location.hash);
    if (cm) {
      window.addEventListener('load', () => {
        const idx = Math.min(parseInt(cm[1], 10) - 1, app.cases.length - 1);
        if (idx >= 0) { app.els.caseSelect.value = idx; setCase(idx); }
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();