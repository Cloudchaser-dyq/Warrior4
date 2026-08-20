/* ============================================================
 * parser.js — 《魔兽世界4AC》日志解析器
 * ------------------------------------------------------------
 * 以 Warcraft.out 标准输出日志为唯一事实来源,还原：
 *   - 单位注册(red/blue + 兵种 + 编号)
 *   - 属性快照(hp / force / morale / loyalty / weapons)
 *   - 事件流(含精确时间戳与城市id)
 * 以 Warcraft.in 为参数源,提供每 Case 的元数据(m/n/r/k/T、初始生命值、初始攻击力)。
 * 若无 .in 或字段异常,则用日志自身内嵌信息兜底推导,保证回放不中断。
 * ============================================================ */
(function (global) {
  'use strict';

  const WARRIOR_NAMES = ['dragon', 'ninja', 'iceman', 'lion', 'wolf'];
  const WARRIOR_LIFE_ORDER = [3, 0, 4, 1, 2, 5]; // 输入生命值顺序: dragon ninja iceman lion wolf
  const TECH_COLORS = { red: 'red', blue: 'blue' };

  /* ---------------- 工具 ---------------- */
  function parseStamp(t) {
    const mm = /^(\d{3}):(\d{2})$/.exec(t);
    if (!mm) return -1;
    return +mm[1] * 60 + +mm[2];
  }
  function stampToTime(stamp) {
    return String(stamp / 60 | 0).padStart(3, '0') + ':' + String(stamp % 60).padStart(2, '0');
  }

  /* ---------------- 输入 .in 解析 ---------------- */
  // 格式:  T 行(默认5行每组)(Case1 参数可循环多组)
  //  首行: t(测试组数), 每组:
  //    m n r k T
  //    5 个初始生命值(dragon ninja iceman lion wolf)
  //    5 个初始攻击力
  function parseInput(inText) {
    if (!inText) return [];
    const nums = [];
    for (const t of inText.split(/[\r\n]+/)) {
      t.replace(/#.*/, '').trim().split(/[ ,\t]+/).forEach((x) => {
        if (x !== '' && /^-?\d+$/.test(x)) nums.push(parseInt(x, 10));
      });
    }
    if (!nums.length) return [];
    const t = nums[0];
    const cases = [];
    let p = 1;
    for (let i = 0; i < t && p + 15 <= nums.length + 1; i++) {
      if (p + 15 > nums.length) break;
      const [m, n, r, k, T] = nums.slice(p, p + 5);
      const life = nums.slice(p + 5, p + 10);   // dragon ninja iceman lion wolf
      const force = nums.slice(p + 10, p + 15);
      cases.push({ m, n, r, k, T, life, force });
      p += 15;
    }
    return cases;
  }

  /* ---------------- 输出日志解析 ---------------- */
  // 返回: { cases: [ {index, config, events: [event] } ] }
  function parseOut(outText, inputCases) {
    const lines = outText.replace(/\r/g, '').split('\n');
    const cases = [];
    let cur = null;
    let caseIdx = -1;

    const flush = (nextIdx) => {
      caseIdx++;
      if (nextIdx !== undefined) caseIdx = nextIdx;
      cur = {
        index: caseIdx + 1,
        config: (inputCases && inputCases[caseIdx]) || null,
        events: [],
        warriors: {},
      };
      cases.push(cur);
    };

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const caseMatch = /^Case\s+(\d+)/i.exec(line);
      if (caseMatch) { flush(+caseMatch[1] - 1); continue; }
      if (!cur) continue;

      const stampMatch = /^(\d{3}:\d{2})\s+(.*)$/.exec(line);
      let stamp = -1, body = line;
      if (stampMatch) { stamp = parseStamp(stampMatch[1]); body = stampMatch[2]; }

      /* 出生 */
      let m = /^(red|blue)\s+(\w+)\s+(\d+)\s+born$/.exec(body);
      if (m) {
        cur.events.push({ t: stamp, type: 'born', side: m[1], kind: m[2], no: +m[3] });
        continue;
      }
      /* 士气 / 忠诚(紧随 born 的附加行,无时间戳) */
      m = /^Its morale is ([+-]?\d+(?:\.\d+)?)$/.exec(body);
      if (m) { cur.events.push({ t: stamp, type: 'moraleLine', value: parseFloat(m[1]) }); continue; }
      m = /^Its loyalty is (\d+)$/.exec(body);
      if (m) { cur.events.push({ t: stamp, type: 'loyaltyLine', value: +m[1] }); continue; }
      /* 到达司令部(行军阶段) */
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+reached\s+(red|blue)\s+headquarter\s+with\s+(\d+)\s+elements\s+and\s+force\s+(\d+)/.exec(body);
      if (m) {
        cur.events.push({ t: stamp, type: 'reachHQ', side: m[1], kind: m[2], no: +m[3], hp: +m[5], force: +m[6], target: m[4] });
        continue;
      }
      /* 司令部被夺 */
      m = /^(red|blue)\s+headquarter\s+was\s+taken$/.exec(body);
      if (m) { cur.events.push({ t: stamp, type: 'hqTaken', side: m[1] }); continue; }
      /* 行军 */
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+marched\s+to\s+city\s+(\d+)\s+with\s+(\d+)\s+elements\s+and\s+force\s+(\d+)/.exec(body);
      if (m) {
        cur.events.push({ t: stamp, type: 'march', side: m[1], kind: m[2], no: +m[3], city: +m[4], hp: +m[5], force: +m[6] });
        continue;
      }
      /* 获元 */
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+earned\s+(\d+)\s+elements\s+for\s+his\s+headquarter/.exec(body);
      if (m) {
        cur.events.push({ t: stamp, type: 'earn', side: m[1], kind: m[2], no: +m[3], amount: +m[4] });
        continue;
      }
      /* 射箭 */
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+shot\s+and\s+killed\s+(red|blue)\s+(\w+)\s+(\d+)/.exec(body);
      if (m) {
        cur.events.push({ t: stamp, type: 'arrowKill', side: m[1], kind: m[2], no: +m[3], vSide: m[4], vKind: m[5], vNo: +m[6] });
        continue;
      }
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+shot$/.exec(body);
      if (m) { cur.events.push({ t: stamp, type: 'arrow', side: m[1], kind: m[2], no: +m[3] }); continue; }
      /* 炸弹 */
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+used a bomb\s+and\s+killed\s+(red|blue)\s+(\w+)\s+(\d+)/.exec(body);
      if (m) {
        cur.events.push({ t: stamp, type: 'bomb', side: m[1], kind: m[2], no: +m[3], vSide: m[4], vKind: m[5], vNo: +m[6] });
        continue;
      }
      /* 战斗 */
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+attacked\s+(red|blue)\s+(\w+)\s+(\d+)\s+in\s+city\s+(\d+)\s+with\s+(\d+)\s+elements\s+and\s+force\s+(\d+)/.exec(body);
      if (m) {
        cur.events.push({ t: stamp, type: 'attacked', side: m[1], kind: m[2], no: +m[3], vSide: m[4], vKind: m[5], vNo: +m[6], city: +m[7], hp: +m[8], force: +m[9] });
        continue;
      }
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+fought\s+back\s+against\s+(red|blue)\s+(\w+)\s+(\d+)\s+in\s+city\s+(\d+)/.exec(body);
      if (m) {
        cur.events.push({ t: stamp, type: 'fightback', side: m[1], kind: m[2], no: +m[3], vSide: m[4], vKind: m[5], vNo: +m[6], city: +m[7] });
        continue;
      }
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+was\s+killed\s+in\s+city\s+(\d+)/.exec(body);
      if (m) {
        cur.events.push({ t: stamp, type: 'killed', side: m[1], kind: m[2], no: +m[3], city: +m[4] });
        continue;
      }
      /* 龙吼 */
      m = /^(red|blue)\s+dragon\s+(\d+)\s+yelled\s+in\s+city\s+(\d+)/.exec(body);
      if (m) { cur.events.push({ t: stamp, type: 'yell', side: m[1], no: +m[2], city: +m[3] }); continue; }
      /* 升旗 */
      m = /^(red|blue)\s+flag\s+raised\s+in\s+city\s+(\d+)/.exec(body);
      if (m) { cur.events.push({ t: stamp, type: 'flagRaised', side: m[1], city: +m[2] }); continue; }
      /* 狮子逃跑 */
      m = /^(red|blue)\s+lion\s+(\d+)\s+ran\s+away$/.exec(body);
      if (m) { cur.events.push({ t: stamp, type: 'lionRunaway', side: m[1], no: +m[2] }); continue; }
      /* 报武器 */
      m = /^(red|blue)\s+(\w+)\s+(\d+)\s+has\s+(.+)$/.exec(body);
      if (m) {
        const has = m[4].trim() === 'no weapon' ? [] : m[4].split(',').map((w) => {
          const wm = /^(sword|bomb|arrow)\((\d+)\)$/.exec(w.trim());
          if (wm) return { name: wm[1], param: +wm[2] }; // arrow(3) → param=剩余次数; sword(4) → 攻击
          if (/^bomb$/.test(w.trim())) return { name: 'bomb', param: 1 };
          return { name: w.trim(), param: 0 };
        });
        cur.events.push({ t: stamp, type: 'reportWpn', side: m[1], kind: m[2], no: +m[3], weapons: has });
        continue;
      }
      /* 司令部生命元 */
      m = /^(\d+)\s+elements\s+in\s+(red|blue)\s+headquarter/.exec(body);
      if (m) { cur.events.push({ t: stamp, type: 'hqLife', value: +m[1], side: m[2] }); continue; }
    }
    return cases;
  }

  /* ---------------- 后处理:为单位注册属性/武器 ---------------- */
  // 在 events 上附加 unitId(kind+no 的全局唯一标识),并写回 warriors 索引。
  // 由于日志事件按时间排序,先 born 后属性行,可直接顺序处理。
  function registerUnit(unit, side, kind, no) {
    const key = side + ':' + kind + ':' + no;
    if (!unit) return key;
    if (!unit.warriors[key]) unit.warriors[key] = { side, kind, no, hp: null, force: null, weapons: [], morale: null, loyalty: null };
    return key;
  }

  /* 统一遍历 cases 填充 unitKey/attribute */
  function finalizeCases(allCases) {
    for (const c of allCases) {
      let unitKey = null;
      for (const ev of c.events) {
        switch (ev.type) {
          case 'born':
            unitKey = registerUnit(c, ev.side, ev.kind, ev.no);
            ev.unitKey = unitKey;
            break;
          case 'moraleLine':
            if (unitKey) { c.warriors[unitKey].morale = ev.value; ev.unitKey = unitKey; }
            break;
          case 'loyaltyLine':
            if (unitKey) { c.warriors[unitKey].loyalty = ev.value; ev.unitKey = unitKey; }
            break;
          case 'march':
            ev.unitKey = registerUnit(c, ev.side, ev.kind, ev.no);
            c.warriors[ev.unitKey].hp = ev.hp; c.warriors[ev.unitKey].force = ev.force;
            break;
          case 'reachHQ':
            ev.unitKey = registerUnit(c, ev.side, ev.kind, ev.no);
            c.warriors[ev.unitKey].hp = ev.hp; c.warriors[ev.unitKey].force = ev.force;
            break;
          case 'arrow': case 'arrowKill': case 'bomb': case 'killed': case 'lionRunaway':
            ev.unitKey = registerUnit(c, ev.side, ev.kind, ev.no);
            if (ev.vNo !== undefined) ev.vUnitKey = registerUnit(c, ev.vSide, ev.vKind, ev.vNo);
            break;
          case 'attacked':
            ev.unitKey = registerUnit(c, ev.side, ev.kind, ev.no);
            c.warriors[ev.unitKey].hp = ev.hp; c.warriors[ev.unitKey].force = ev.force;
            ev.vUnitKey = registerUnit(c, ev.vSide, ev.vKind, ev.vNo);
            break;
          case 'fightback': case 'yell':
            ev.unitKey = registerUnit(c, ev.side, ev.kind, ev.no);
            break;
          case 'reportWpn':
            ev.unitKey = registerUnit(c, ev.side, ev.kind, ev.no);
            c.warriors[ev.unitKey].weapons = ev.weapons;
            break;
          case 'earn':
            ev.unitKey = registerUnit(c, ev.side, ev.kind, ev.no);
            break;
          case 'flagRaised': case 'hqLife': case 'hqTaken':
            ev.unitKey = ev.unitKey || null;
            break;
        }
      }
    }
    return allCases;
  }

  /* ---------------- 导出 ---------------- */
  function parse(inText, outText) {
    const inputCases = parseInput(inText);
    const cases = parseOut(outText, inputCases);
    return finalizeCases(cases);
  }

  global.WarcraftParser = { parse, parseInput, parseOut, WARRIOR_NAMES, WARRIOR_LIFE_ORDER, stampToTime };
})(typeof window !== 'undefined' ? window : globalThis);