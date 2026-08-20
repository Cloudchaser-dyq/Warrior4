/* ============================================================
 * engine.js — 《魔兽世界4AC》场景状态机
 * ------------------------------------------------------------
 * 输入: parser 产出的 case 事件流。
 * 输出: 按"分钟"推进的离散场景快照(snapshot)数组。
 *
 * 场景模型(per case):
 *   hq:   { red:{life, warriorCount, occupier, taken}, blue:{...} }
 *   city: [ {id, flag:0/1/2, element, red, blue, spawnFlash} ]  (red/blue = 单位key)
 *   units:{ [key]: {side,kind,no,hp,force,weapons,morale,loyalty,
 *                    city:int|null, inHQ:'red'|'blue'|null,
 *                    alive, justBorn} }
 *
 * 城市约定(与原 C++ 一致):
 *   city 0    = 红方司令部(红武士出生地)
 *   city n+1  = 蓝方司令部(蓝武士出生地)
 *   城 1..n   = 普通城;红武士从左向右(+1)攻向蓝 HQ,蓝武士反向。
 *
 * 事件顺序与日志一致 = 绝对事实;状态机只是"执行日志事件,
 * 在被事件提及的字段上施加后果",未提及字段保持原值。
 * ============================================================ */

(function (global) {
  'use strict';

  /* ------------- 工具 ------------- */
  function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

  function emptyCase(n) {
    const city = [];
    for (let i = 0; i <= n + 1; i++) {
      city[i] = { id: i, flag: 0, element: 0, red: null, blue: null, spawnFlash: false };
    }
    return {
      hq: {
        red: { life: 0, warriorCount: 0, occupier: null, taken: false },
        blue: { life: 0, warriorCount: 0, occupier: null, taken: false },
      },
      city,
      units: {},
    };
  }

  /* 把单位从旧位置移除(城/司令部),清干净 */
  function detachUnit(state, ukey_) {
    const u = state.units[ukey_];
    if (!u) return;
    if (u.city != null) {
      const c = state.city[u.city];
      if (c.red === ukey_) c.red = null;
      if (c.blue === ukey_) c.blue = null;
    }
    if (u.inHQ) {
      const h = state.hq[u.inHQ];
      if (h.occupier === ukey_) h.occupier = null;
    }
  }

  /* 把单位放到指定位置:
     to:  'hqRed' | 'hqBlue' | 整数(城id) */
  function placeUnit(state, ukey_, to) {
    const u = state.units[ukey_];
    if (!u) return;
    detachUnit(state, ukey_);
    u.city = null; u.inHQ = null;
    if (to === 'hqRed') {
      u.inHQ = 'red';
      state.hq.red.occupier = ukey_;
    } else if (to === 'hqBlue') {
      u.inHQ = 'blue';
      state.hq.blue.occupier = ukey_;
    } else {
      u.city = to;
      const c = state.city[to];
      c[u.side] = ukey_;
    }
  }

  function removeUnit(state, ukey_) {
    detachUnit(state, ukey_);
    const u = state.units[ukey_];
    if (u) { u.alive = false; u.hp = 0; }
  }

  /* ------------- 事件→状态 ------------- */
  function applyEvent(state, ev, n) {
    switch (ev.type) {
      case 'born': {
        const key = ev.unitKey;
        state.units[key] = {
          side: ev.side, kind: ev.kind, no: ev.no,
          hp: null, force: null, weapons: [], morale: null, loyalty: null,
          city: null, inHQ: null, alive: true, justBorn: true,
        };
        state.hq[ev.side].warriorCount++;
        // 红武士在城0(红HQ)出生,蓝武士在城n+1(蓝HQ)出生
        placeUnit(state, key, ev.side === 'red' ? 'hqRed' : 'hqBlue');
        // 出生点在司令部,渲染层用 hq.warriorCount 展示,不需在城格
        break;
      }
      case 'moraleLine': {
        const u = state.units[ev.unitKey];
        if (u) u.morale = ev.value;
        break;
      }
      case 'loyaltyLine': {
        const u = state.units[ev.unitKey];
        if (u) u.loyalty = ev.value;
        break;
      }
      case 'march': {
        const key = ev.unitKey, u = state.units[key];
        if (u) {
          u.hp = ev.hp; u.force = ev.force;
          u.fromCity = u.city;         // 记录来向(渲染插值用)
          u.fromHQ = u.inHQ;
          placeUnit(state, key, ev.city);
        }
        break;
      }
      case 'reachHQ': {
        const key = ev.unitKey, u = state.units[key];
        if (u) {
          u.hp = ev.hp; u.force = ev.force;
          placeUnit(state, key, ev.target === 'red' ? 'hqRed' : 'hqBlue');
          state.hq[ev.target].underSiege = true;
        }
        break;
      }
      case 'hqTaken': {
        state.hq[ev.side].taken = true;
        state.over = true;
        break;
      }
      case 'arrowKill': case 'bomb': case 'killed': {
        // killed:  victim 是 unitKey; arrowKill: victim 是 vUnitKey(射箭者存活);
        // bomb:     持弹者(unitKey)同归于尽,vUnitKey 也被炸死
        if (ev.vUnitKey) removeUnit(state, ev.vUnitKey);
        if (ev.unitKey && ev.type !== 'arrowKill') removeUnit(state, ev.unitKey);
        break;
      }
      case 'attacked': {
        const u = state.units[ev.unitKey];
        if (u) { u.hp = ev.hp; u.force = ev.force; }
        break;
      }
      case 'reportWpn': {
        const u = state.units[ev.unitKey];
        if (u) u.weapons = ev.weapons.map(w => ({ ...w }));
        break;
      }
      case 'hqLife': {
        state.hq[ev.side].life = ev.value;
        break;
      }
      case 'flagRaised': {
        state.city[ev.city].flag = ev.side === 'red' ? 1 : 2;
        break;
      }
      // 下列事件不改场景状态(UI 直接消费事件日志):
      case 'earn': {
        // 收复: 该单位所在城被清空元素(amount 即该城当时所含元素)
        // 由 unitKey 的当前城定位;若不可定位(已死/在营)则跳过显示
        const u = state.units[ev.unitKey];
        if (u && u.city != null) {
          state.city[u.city].element = 0;
          state.lastEarn = { city: u.city, amount: ev.amount };
        }
        break;
      }
      case 'arrow':
      case 'fightback':
      case 'yell':
      case 'lionRunaway':
      default:
        break;
    }
  }

  /* 在事件序列推进中,于每个整分钟为所有城 +10 元素(:20 产元素事件)。
     由于 .out 日志未输出该事件,这里直接按时间戳注入。 */
  function produceElementAtMinutes(state, minute, n) {
    if (minute % 60 === 20) {
      for (let i = 1; i <= n; i++) state.city[i].element += 10;
    }
  }

  /* ------------- 主流程 ------------- */
  // 输入: caseData(parser 产物);输出 { snapshots, n, over, events }
  function buildCase(caseData) {
    const n = caseData.config ? caseData.config.n : inferN(caseData.events);
    const state = emptyCase(n);
    if (caseData.config) {
      state.hq.red.life = caseData.config.m;
      state.hq.blue.life = caseData.config.m;
    }
    // 兵力出厂序列(用于 UI 侧显示 "下一个造谁"),直接交给 UI 由 events 推导即可

    const snapshots = [];
    let prevStamp = 0;
    let endStamp = 0;

    // 第一分钟快照(时刻 0,无事件)
    state.minute = 0;
    snapshots.push(cloneState(state));

    const events = caseData.events.filter(e => e.t >= 0);
    const advanceTo = (to) => {
      while (prevStamp < to) {
        prevStamp += 1;
        state.minute = prevStamp;
        produceElementAtMinutes(state, prevStamp, n);
        snapshots.push(cloneState(state));
      }
    };
    for (const ev of events) {
      // 若时间跳跃,先补"空转"快照(无事件分钟,含 :20 产元素)
      advanceTo(ev.t);
      const thisMinute = ev.t;
      // 若要推进的分钟自己就是当前事件分钟,先不要补空帧(下面事件快照覆盖)
      if (prevStamp > thisMinute) prevStamp = thisMinute; // 同分钟重复事件保护
      applyEvent(state, ev, n);
      state.spinMinute = thisMinute;
      state.minute = thisMinute;
      snapshots.push(cloneState(state));
      prevStamp = thisMinute;
      endStamp = thisMinute;
    }
    // 配置的 T 若大于最后事件时间,继续补到尾
    const configT = caseData.config ? caseData.config.T : 0;
    const finalT = Math.max(endStamp, configT);
    advanceTo(finalT);
    return { snapshots, n, over: !!state.over, events };
  }

  function inferN(events) {
    let mx = 0;
    for (const e of events) {
      if ((e.type === 'march' || e.type === 'attacked' || e.type === 'killed' ||
           e.type === 'flagRaised' || e.type === 'fightback' || e.type === 'yell') &&
          e.city != null && e.city > mx) mx = e.city;
    }
    return Math.max(1, mx);
  }

  global.WarcraftEngine = { buildCase, emptyCase };
})(typeof window !== 'undefined' ? window : globalThis);