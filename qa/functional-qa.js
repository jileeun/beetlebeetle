// =====================================================================
//  기능 QA 자동 점검  (에이전트: .claude/agents/functional-qa.md)
//  브라우저 콘솔 / 자동화 도구에서:   await FunctionalQA.run()          // 전체
//                                     await FunctionalQA.run({ play: [0, 4, 9] })  // 실제 엔진 자동 플레이할 스테이지 지정
//  저장된 진행도·부스터는 점검 전에 백업하고 끝나면 되돌린다.
// =====================================================================
(function () {
  'use strict';
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) }); return ok; };

  // ---- 1. 밸런스 표 ----
  function testBalanceTable() {
    check('BALANCE 로드됨', !!window.BALANCE, 'balance/balance.js 를 못 읽음');
    for (let i = 0; i < BASE_COUNT; i++) {
      const st = STAGES[i];
      check(`스테이지 ${i + 1} 등급 존재`, !!BAL.tiers[st.tier], st.tier);
      check(`스테이지 ${i + 1} 일터 칸 1~5`, st.slots >= 1 && st.slots <= 5, st.slots);
      check(`스테이지 ${i + 1} 확률 범위`, st.link >= 0 && st.link <= 1 && st.jitter >= 0 && st.jitter <= 1, `${st.link}/${st.jitter}`);
    }
    for (const k of BAL.boosterOrder) check(`부스터 ${k} 정의`, !!BAL.boosters[k]);
    // 보상: 10스테이지마다 1~3개
    for (let s = 0; s + 10 <= BASE_COUNT; s += 10) {   // 10스테이지가 다 찬 구간만
      let n = 0;
      for (let i = s; i < Math.min(BASE_COUNT, s + 10); i++) { const r = clearReward(i); if (r) n += Object.values(r).reduce((a, b) => a + b, 0); }
      check(`보상 개수 ${s + 1}~${s + 10} 스테이지 (1~3개)`, n >= 1 && n <= 3, n);
    }
  }

  // ---- 2. 스테이지 생성 일관성 ----
  function testGeneration(from = 0, to = BASE_COUNT) {
    for (let i = from; i < to; i++) {
      const d = buildStage(i);
      const cells = {}, ants = {};
      d.grid.forEach(r => r.forEach(v => { if (v) cells[v] = (cells[v] || 0) + 1; }));
      d.cols.flat().forEach(a => { ants[a.color] = (ants[a.color] || 0) + a.total; });
      const bad = Object.keys({ ...cells, ...ants }).filter(k => cells[k] !== ants[k]);
      check(`스테이지 ${i + 1} 음식 수 = 쇠똥구리 숫자 합`, !bad.length, bad.map(k => `${k}:${cells[k]}≠${ants[k]}`).join(' '));
      const zero = d.cols.flat().filter(a => a.total <= 0).length;
      check(`스테이지 ${i + 1} 0마리 쇠똥구리 없음`, !zero, zero);
      let badLink = 0;
      d.cols.forEach((col, c) => col.forEach((a, r) => {
        if (!a.group) return;
        // 같은 높이 이웃, 또는 레슨용 엇갈린 사슬(gen.skew)이면 이웃 줄의 다른 높이도 허용
        const skew = STAGES[i].gen && STAGES[i].gen.skew;
        const ok = a.group.members.length === 2 && a.group.members.every(m => d.cols.some((cc, ci) => Math.abs(ci - c) <= 1 && (skew ? cc.includes(m) : cc[r] === m)));
        if (!ok) badLink++;
      }));
      check(`스테이지 ${i + 1} 사슬은 이웃 줄끼리`, !badLink, badLink);
      const s = BalanceQA.evaluate(i, { random: 4, greedy: 8, smart: 60 });
      check(`스테이지 ${i + 1} 풀 수 있음 (QA 시뮬)`, s.solvable, JSON.stringify(s));
    }
  }

  // ---- 게임 상태 불변식: 남은 음식 = 대기열 숫자 + 일터 남은 숫자 + 가지러 가는 중 ----
  function countInvariant(g) {
    const q = g.queues.flat().reduce((s, a) => s + a.total, 0);
    const sl = g.slots.reduce((s, a) => s + (a ? a.total - a.dispatched : 0), 0);
    const go = g.carriers.filter(c => c.state === 'go').length;
    return { ok: q + sl + go === g.remaining, q, sl, go, remaining: g.remaining };
  }

  // 실제 엔진을 화면 없이 빠르게 돌리는 자동 플레이 (greedy)
  function botPick() {
    const g = game;
    if (g.state !== 'play' || !freeSlots().length) return;
    const working = g.slots.some(a => a && hasTarget(a.color));
    const free = freeSlots().length;
    const legal = [];
    for (let c = 0; c < 3; c++) {   // 실제로 고를 수 있는 것만 (사슬은 둘 다 맨 위 + 빈 칸 충분)
      const a = g.queues[c][0];
      if (!a || c === g.lockedCol) continue;   // ⛓ 잠긴 줄은 못 고름
      const ms = a.group ? a.group.members : [a];
      if (ms.every(m => g.queues[m.col][0] === m) && free >= ms.length) legal.push({ c, ms });
    }
    const good = legal.find(o => o.ms.every(m => hasTarget(m.color)));
    if (good) { tryPick(good.c, 0); return; }
    if (!working && !g.carriers.length && legal.length) tryPick(legal[0].c, 0);
  }
  // rescue: 실패하면 부스터(열쇠 → 돌려보내기)로 이어하기, 최대 rescue 번
  function runEngine(maxSteps = 8000, rescue = 0) {
    let border = 0, inv = 0, used = 0, stall = 0, lastSig = '', same = 0;
    for (let k = 0; k < maxSteps; k++) {
      if (game.state === 'fail' && used < rescue) {
        inventory.undo = 9; inventory.key = 9;
        if (useBooster(game.locks.some(L => !L.open) ? 'key' : 'undo')) used++;   // 실패 화면에서 플레이어가 고를 만한 순서
      }
      if (game.state !== 'play') break;
      botPick();
      update(0.05);
      if (k % 10 === 0) { border += borderHits(); if (!countInvariant(game).ok) inv++; }
      // 교착 감지: 쇠똥구리가 있는데 위치가 하나도 안 바뀐 채 200단계(약 90초 게임 시간)
      const sig = game.carriers.map(c => (c.x | 0) + ',' + (c.y | 0)).join(';');
      if (game.carriers.length && sig === lastSig) { if (++same === 200) stall++; } else same = 0;
      lastSig = sig;
    }
    return { state: game.state, remaining: game.remaining, border, inv, rescued: used, stall };
  }

  // ---- 3. 테두리 침범: 바깥 네모 길 위 쇠똥구리가 그림판 테두리(액자 선)를 밟지 않는지 ----
  // drawPlay 와 같은 차선 규칙으로 그려질 위치를 계산해서 액자 안쪽 경계와 비교
  function borderHits() {
    const g = game, BP = beetlePx(), T = g.T, inner = FRAME_IN;
    let hits = 0;
    for (const cr of g.carriers) {
      if (cr.state !== 'go') continue;
      const ux = Math.cos(cr.ang), uy = Math.sin(cr.ang), vertical = Math.abs(uy) > Math.abs(ux);
      const onTop = Math.abs(cr.y - T.y0) < 1, onL = Math.abs(cr.x - T.x0) < 1, onR = Math.abs(cr.x - T.x1) < 1;
      if (!(onTop || onL || onR)) continue;
      // drawPlay 와 같게: 꺾는 곳은 다듬은 길(crView)의 위치·방향으로 그림
      const view = typeof crView === 'function' ? crView(cr) : { x: cr.x, y: cr.y, ang: cr.ang }, realAng = cr.ang;
      cr.ang = view.ang;
      const [lx, ly] = laneOffset(cr, BP);   // 게임 그리기와 같은 함수
      const sp = getSprite(crPose(cr).side ? 'beetleWalk0' : 'beetle0', cr.color, 0, BP);   // 아래로 갈 때도 옆모습 (drawPlay 와 같은 자세)
      cr.ang = realAng;
      const x = view.x + lx, y = view.y + ly;
      if (x - sp.lw / 2 < inner.x0 - 0.5 || x + sp.lw / 2 > inner.x1 + 0.5 || y - sp.lh / 2 < inner.y0 - 0.5) hits++;
    }
    return hits;
  }

  function testEngine(play) {
    const keepSpeed = speed, keepMode = mode, keepInv = { ...inventory };
    mode = 'solo'; speed = 9;
    for (const i of play) {
      startStage(i); overlay = null;
      const exp = (5 - (STAGES[i].slots || 5)) + game.locks.filter(L => L.type === 'slot').length;
      check(`스테이지 ${i + 1} 잠긴 일터 ${exp}칸`, game.locked.filter(Boolean).length === exp, game.locked);
      check(`스테이지 ${i + 1} 자물쇠 수 = 그림 속 열쇠 수`, game.locks.length === game.keys.size, `${game.locks.length}/${game.keys.size}`);
      const iceN = Math.round(((STAGES[i].gimmicks || {}).ice || 0) * game.total);
      check(`스테이지 ${i + 1} 얼음 배치`, !iceN || game.ice.size > 0, `${game.ice.size}/${iceN}`);
      const hurdle = STAGES[i].tier === 'hard' || STAGES[i].tier === 'boss';
      const r = runEngine(8000, hurdle ? 6 : 0);   // 허들은 막히면 부스터로 이어하기 (실제 플레이어처럼)
      check(`스테이지 ${i + 1} 실제 엔진 자동 플레이 클리어${hurdle ? ' (부스터 이어하기 허용)' : ''}`, r.state === 'clear', JSON.stringify(r));
      check(`스테이지 ${i + 1} 테두리 밟음 0회`, r.border === 0, r.border);
      check(`스테이지 ${i + 1} 숫자 불변식 유지`, r.inv === 0, r.inv);
      check(`스테이지 ${i + 1} 쇠똥구리 교통 체증 멈춤 없음`, r.stall === 0, r.stall);
      if (r.state === 'clear') {
        check(`스테이지 ${i + 1} 끝나면 얼음·열쇠·선물 0`, !game.ice.size && !game.keys.size && !game.gifts.size, `${game.ice.size}/${game.keys.size}/${game.gifts.size}`);
        check(`스테이지 ${i + 1} 끝나면 자물쇠 모두 열림`, game.locks.every(L => L.open));
      }
    }
    speed = keepSpeed; mode = keepMode; inventory = keepInv;
  }

  // ---- 4. 부스터 ----
  function testBoosters() {
    const keepMode = mode; mode = 'solo';
    const hard = STAGES.findIndex(s => (s.gimmicks || {}).lockSlots);
    startStage(hard); overlay = null;
    inventory = { undo: 2, key: 1, unchain: 1, bomb: 1 };
    // 일터 채우기
    for (let k = 0; k < 5; k++) for (let c = 0; c < 3; c++) if (game.queues[c][0] && !game.queues[c][0].group && freeSlots().length) tryPick(c, 0);
    check('잠긴 칸에는 쇠똥구리가 안 들어감', game.slots.every((a, k) => !(a && game.locked[k])));
    const nQ = game.queues.flat().length;
    check('돌려보내기 사용 가능', useBooster('undo'));
    check('돌려보내기: 대기열 +1', game.queues.flat().length === nQ + 1);
    check('돌려보내기 후 숫자 불변식', countInvariant(game).ok, JSON.stringify(countInvariant(game)));
    check('돌려보내기 개수 감소', inventory.undo === 1);
    const lockedBefore = game.locks.filter(L => !L.open).length;
    check('열쇠 사용', useBooster('key'));
    check('열쇠: 자물쇠 -1', game.locks.filter(L => !L.open).length === lockedBefore - 1);
    check('자물쇠 없으면 열쇠 못 씀', lockedBefore > 1 || boosterBlock('key') !== null);
    game.queues[0][0] && game.queues[1][0] && (() => { const grp = { members: [game.queues[0][0], game.queues[1][0]] }; grp.members.forEach(m => m.group = grp); })();
    check('사슬 끊기 사용', useBooster('unchain'));
    check('사슬 끊기: 사슬 0개', !game.queues.flat().some(a => a.group));
    const rem = game.remaining;
    check('폭탄 조준 시작', useBooster('bomb') && game.aim === 'bomb');
    const k0 = [...game.reach.acc.keys()][0], r0 = Math.floor(k0 / game.C), c0 = k0 % game.C;
    placeBomb(game.gx + (c0 + 0.5) * game.cs, game.gy + (r0 + 0.5) * game.cs);
    check('폭탄: 음식 감소', game.remaining < rem, `${rem}→${game.remaining}`);
    check('폭탄: 개수 감소', inventory.bomb === 0);
    check('폭탄 후 숫자 불변식', countInvariant(game).ok, JSON.stringify(countInvariant(game)));
    check('없는 부스터는 못 씀', !useBooster('bomb'));
    // 실패 → 부스터로 이어하기
    game.state = 'fail'; overlay = 'fail';
    check('실패 화면에서 돌려보내기로 이어하기', useBooster('undo') && game.state === 'play' && overlay === null);
    // 경쟁 모드에서는 못 씀
    mode = 'versus';
    check('경쟁 모드에서는 부스터 못 씀', boosterBlock('undo') !== null);
    mode = keepMode;
  }

  // ---- 4-1. 기믹 규칙 ----
  function testGimmicks() {
    const keepMode = mode; mode = 'solo';
    const iceSt = STAGES.findIndex(s => (s.gimmicks || {}).ice);
    startStage(iceSt); overlay = null;
    const g = game;
    // 얼음 칸은 목표가 안 됨
    const k = [...g.ice].find(k => g.reach.acc.has(k));
    if (k != null) {
      const r = Math.floor(k / g.C), c = k % g.C, col = g.grid[r][c];
      const others = [...g.reach.acc.keys()].filter(x => x !== k && g.grid[Math.floor(x / g.C)][x % g.C] === col && !g.ice.has(x));
      others.forEach(x => g.reserved[Math.floor(x / g.C)][x % g.C] = true);
      check('얼음 칸은 가져갈 대상이 아님', !findTarget(col, 200, 520), col);
      others.forEach(x => g.reserved[Math.floor(x / g.C)][x % g.C] = false);
    }
    // 옆 음식이 없어지면 얼음이 깨짐
    const ik = [...g.ice][0], ir = Math.floor(ik / g.C), ic = ik % g.C;
    const nb = D4.map(([dr, dc]) => [ir + dr, ic + dc]).find(([r, c]) => r >= 0 && c >= 0 && r < g.R && c < g.C && g.grid[r][c] && !g.ice.has(r * g.C + c));
    if (nb) { g.grid[nb[0]][nb[1]] = null; onCellGone(nb[0], nb[1]); check('옆 음식이 없어지면 얼음 깨짐', !g.ice.has(ik)); }
    // 열쇠를 먹으면 자물쇠가 열림 + 잠긴 줄
    const colSt = STAGES.findIndex(s => (s.gimmicks || {}).lockCols);
    startStage(colSt); overlay = null;
    check('잠긴 줄 존재', game.lockedCol >= 0, game.lockedCol);
    const lc = game.lockedCol;
    if (game.queues[lc][0]) { const n = freeSlots().length; tryPick(lc, 0); check('잠긴 줄은 고를 수 없음', freeSlots().length === n); }
    let guard = 0;
    while (game.keys.size && guard++ < 5) { const kk = [...game.keys][0]; onCellGone(Math.floor(kk / game.C), kk % game.C); }
    check('열쇠를 다 먹으면 자물쇠 모두 열림', game.locks.every(L => L.open) && game.lockedCol === -1 && !game.locked.some(Boolean));
    // 선물
    const giftSt = STAGES.findIndex(s => ((s.gimmicks || {}).giftAt || []).length);
    startStage(giftSt); overlay = null;
    const before = boosterTotal(), gk = [...game.gifts][0];
    onCellGone(Math.floor(gk / game.C), gk % game.C);
    check('선물 음식을 먹으면 부스터 +1', boosterTotal() === Math.min(before + 1, before + 1), `${before}→${boosterTotal()}`);
    mode = keepMode;
  }

  // ---- 5. 보상 / 진행도 ----
  function testRewards() {
    inventory = {}; for (const k of BAL.boosterOrder) inventory[k] = 0;
    const boss = STAGES.findIndex(s => s.tier === 'boss');
    cleared = boss - 1;
    firstClear(boss - 1);
    check('보스 직전 스테이지 클리어 선물', !!lastGift && boosterTotal() >= 1, JSON.stringify(lastGift));
    const before = boosterTotal();
    firstClear(boss - 1);   // 이미 깬 스테이지 다시 깸
    check('이미 깬 스테이지는 선물 없음', boosterTotal() === before);
    firstClear(boss);
    check('보스 클리어 선물', boosterTotal() > before);
    inventory.undo = 99; saveInventory(); loadInventory();
    check('부스터 최대 개수 제한', inventory.undo <= (BAL.maxPerBooster || 9), inventory.undo);
  }

  // ---- 4-2. 레슨 검증 (실제 엔진): "함정 전략은 막히고, 레슨대로 하면 풀린다" ----
  //  stages[n].qa.engine = { randomFail, greedyFail, fullFail } 구간을 실제 엔진 자동 플레이로 확인
  //  정책  random: 빈 칸이 생기면 곧 아무거나 / greedy: 닿는 색이면 바로 / full: 숫자까지 보고, 모자라면 기다림 (1장 전부)
  //        chain: full + 사슬을 위해 칸 2개 비워 두기 + 사슬 짝을 가린 줄 먼저 꺼내기 (2장 전부)
  //        key: full + 🔑까지 길을 내는 색 먼저 (3장) / ice: full + 얼음 옆 색 먼저 (+ 열쇠가 있으면 key 요령) (4장)
  function lessonRun(i, policy, seed) {
    const rng = mulberry32(seed), keep = { speed, mode };
    mode = 'solo'; speed = 9;
    startStage(i); overlay = null;
    const g = game;
    const reachN = color => {
      let n = 0;
      for (const k of g.reach.acc.keys()) { const r = Math.floor(k / g.C), c = k % g.C; if (g.grid[r][c] === color && !g.reserved[r][c] && !g.ice.has(k)) n++; }
      return n;
    };
    // 🔑까지 가장 적게 먹고 갈 수 있는 길 위의 음식 색들 (지금 닿는 칸의 색이 있으면 그것만 = 다음에 팔 색)
    let kcAt = -1, kcSet = null;
    const keyColors = () => {
      if (!g.keys.size) return null;
      if (kcAt === g.remaining) return kcSet;
      kcAt = g.remaining;
      const R = g.R, C = g.C, cost = new Array(R * C).fill(Infinity), par = new Array(R * C).fill(-1), done = new Array(R * C).fill(false);
      const w = k => g.grid[Math.floor(k / C)][k % C] ? (g.ice.has(k) ? 3 : 1) : 0;
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (r === 0 || c === 0 || r === R - 1 || c === C - 1) cost[r * C + c] = w(r * C + c);
      // 예전: 매번 전체 칸을 훑어 (비용, 칸 번호)가 가장 작은 칸을 고름 → O(N²).
      // 지금: (비용, 칸 번호) 순 최소 힙에서 꺼냄 → 꺼내는 순서가 같아서 결과(par)도 똑같음
      const hc = [], hk = [];
      const less = (i, j) => hc[i] < hc[j] || (hc[i] === hc[j] && hk[i] < hk[j]);
      const swap = (i, j) => { const c0 = hc[i]; hc[i] = hc[j]; hc[j] = c0; const k0 = hk[i]; hk[i] = hk[j]; hk[j] = k0; };
      const hpush = (cv, k) => { let i = hc.length; hc.push(cv); hk.push(k); while (i > 0) { const q = (i - 1) >> 1; if (!less(i, q)) break; swap(i, q); i = q; } };
      const hpop = () => {
        const k = hk[0], lc = hc.pop(), lk = hk.pop(), L = hc.length;
        if (L) { hc[0] = lc; hk[0] = lk; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < L && less(l, m)) m = l; if (r < L && less(r, m)) m = r; if (m === i) break; swap(i, m); i = m; } }
        return k;
      };
      for (let k = 0; k < R * C; k++) if (cost[k] < Infinity) hpush(cost[k], k);
      for (;;) {
        let b = -1;
        while (hc.length) { const cv = hc[0], k = hpop(); if (!done[k] && cv === cost[k]) { b = k; break; } }
        if (b < 0) break;
        done[b] = true;
        const r = Math.floor(b / C), c = b % C;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue;
          const n = nr * C + nc, v = cost[b] + w(n);
          if (v < cost[n]) { cost[n] = v; par[n] = b; hpush(v, n); }
        }
      }
      let key = -1;
      for (const k of g.keys) if (key < 0 || cost[k] < cost[key]) key = k;
      const all = new Set(), now = new Set();
      for (let k = key; k >= 0; k = par[k]) {
        const col = g.grid[Math.floor(k / C)][k % C];
        if (!col) continue;
        all.add(col);
        if (g.reach.acc.has(k) && !g.ice.has(k)) now.add(col);
      }
      return (kcSet = now.size ? now : all);
    };
    const pick = () => {
      if (g.state !== 'play' || !freeSlots().length) return;
      const free = freeSlots().length, legal = [];
      for (let c = 0; c < 3; c++) {
        const a = g.queues[c][0];
        if (!a || c === g.lockedCol) continue;
        const ms = a.group ? a.group.members : [a];
        if (ms.every(m => g.queues[m.col][0] === m) && free >= ms.length) legal.push({ c, ms });
      }
      if (!legal.length) return;
      const any = arr => arr[Math.floor(rng() * arr.length)];
      const working = g.slots.some(a => a && hasTarget(a.color)) || g.carriers.length > 0;
      if (policy === 'random') { if (rng() < 0.3) tryPick(any(legal).c, 0); return; }
      if (policy === 'greedy') {
        const good = legal.filter(o => o.ms.every(m => hasTarget(m.color)));
        if (good.length) tryPick(any(good).c, 0); else if (!working) tryPick(any(legal).c, 0);
        return;
      }
      const fill = a => { const busy = g.slots.filter(s => s && s.color === a.color).reduce((t, s) => t + s.total - s.dispatched, 0); return (reachN(a.color) - busy) / a.total; };
      const sc = o => Math.min(...o.ms.map(fill));
      if (policy.startsWith('chain')) {   // chainWait = ①만, chainFree = ②만 (어느 요령이 결정적인지 재 보는 용도)
        const doWait = policy !== 'chainFree', doFree = policy !== 'chainWait';
        // 2장: 사슬을 아는 플레이어
        //  ① 쓸 만한 사슬이 둘 다 맨 위면: 빈 칸 2개가 될 때까지 다른 쇠똥구리를 넣지 않고 기다렸다가 사슬을 넣음
        //  ② 사슬 한쪽만 맨 위면: 짝을 가리고 있는 줄의 맨 위를 먼저 꺼냄
        const tops = [0, 1, 2].map(c => c === g.lockedCol ? null : g.queues[c][0]);
        const ready = [], blockers = new Set();
        for (const a of tops) {
          if (!a || !a.group) continue;
          const ms = a.group.members;
          if (ms.every(m => g.queues[m.col][0] === m)) { if (!ready.some(r => r.group === a.group)) ready.push(a); }
          else if (doFree) for (const m of ms) if (g.queues[m.col][0] !== m && g.queues[m.col][0]) blockers.add(m.col);
        }
        const useful = ready.filter(a => a.group.members.some(m => fill(m) > 0));
        if (doWait && useful.length) {
          const best = useful.sort((p, q) => Math.min(...q.group.members.map(fill)) - Math.min(...p.group.members.map(fill)))[0];
          if (free >= 2) { tryPick(best.col, 0); return; }
          if (working) return;   // 칸 2개를 비워 두려고 기다림
        }
        const singles = legal.filter(o => o.ms.length === 1);
        const full = singles.filter(o => sc(o) >= 1);
        const unblock = full.filter(o => blockers.has(o.c));
        if (unblock.length) { tryPick(any(unblock).c, 0); return; }
        if (full.length) { tryPick(any(full).c, 0); return; }
        if (!working) {
          const ub = legal.filter(o => blockers.has(o.c));
          const pool = ub.length ? ub : legal;
          tryPick(pool.sort((a, b) => sc(b) - sc(a))[0].c, 0);
        }
        return;
      }
      const full = legal.filter(o => sc(o) >= 1);
      if (policy === 'ice') {
        // 4장: 얼음을 아는 플레이어 = full + "얼음 바로 옆의, 지금 닿는 음식 색"을 먼저 골라 길목 얼음을 녹임
        //  ① 숫자를 다 채울 수 있는 쇠똥구리 중 얼음 옆 색이 있으면 그것부터
        //  ② 없으면, 얼음 옆 색이고 닿는 음식이 있으면 숫자가 모자라도 넣음 (빈 칸이 2개 이상일 때)
        //  얼음이 다 녹았으면 3장(key) 요령으로 넘어감
        const ic = new Set();
        for (const k of g.ice) {
          const r = Math.floor(k / g.C), c = k % g.C;
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nr = r + dr, nc = c + dc, n = nr * g.C + nc;
            if (nr < 0 || nc < 0 || nr >= g.R || nc >= g.C || g.ice.has(n) || !g.grid[nr][nc] || g.reserved[nr][nc]) continue;
            if (g.reach.acc.has(n)) ic.add(g.grid[nr][nc]);
          }
        }
        const onIce = o => o.ms.some(m => ic.has(m.color));
        const fi = full.filter(onIce);
        if (fi.length) { tryPick(any(fi).c, 0); return; }
        const part = legal.filter(o => onIce(o) && o.ms.every(m => hasTarget(m.color)));
        if (part.length && free >= 2) { tryPick(any(part).c, 0); return; }
      }
      if (policy === 'key' || (policy === 'ice' && g.keys.size)) {
        // 3장: 열쇠를 아는 플레이어 = full + "🔑까지 가는 길을 막고 있는 색"을 먼저 고름
        //  ① 숫자를 다 채울 수 있는 쇠똥구리 중 열쇠 길 색이 있으면 그것부터
        //  ② 없으면, 열쇠 길 색이고 닿는 음식이 있으면 숫자가 모자라도 넣음 (빈 칸이 2개 이상일 때 — 길을 파서 칸을 늘리는 투자)
        const kc = keyColors();
        const onPath = o => kc && o.ms.some(m => kc.has(m.color));
        const fp = full.filter(onPath);
        if (fp.length) { tryPick(any(fp).c, 0); return; }
        const part = legal.filter(o => onPath(o) && o.ms.every(m => hasTarget(m.color)));
        if (part.length && free >= 2) { tryPick(any(part).c, 0); return; }
      }
      if (full.length) { tryPick(any(full).c, 0); return; }
      if (!working) tryPick(legal.sort((a, b) => sc(b) - sc(a))[0].c, 0);
    };
    for (let k = 0; k < 12000 && g.state === 'play'; k++) { pick(); update(0.05); }
    const st = g.state;
    speed = keep.speed; mode = keep.mode;
    return st;
  }
  // 지문: 판 결과 + 걸음 수 + 25걸음마다 쇠똥구리 위치·남은 음식 해시 (워커 결과가 페이지와 같은지 확인용)
  function lessonPrint(i, policy, seed) {
    let h = 0, n = 0;
    const ou = window.update;
    window.update = dt => {
      ou(dt);
      if (++n % 25) return;
      for (const c of game.carriers) h = (h * 31 + Math.round(c.x * 10) * 7 + Math.round(c.y * 10)) | 0;
      h = (h * 31 + game.remaining) | 0;
    };
    try { return [lessonRun(i, policy, seed), n, h]; } finally { window.update = ou; }
  }
  // ---- 레슨 판을 웹 워커 여러 개로 나눠 돌리기 (qa/qa-worker.js) ----
  function makePool(size) {
    const base = new URL('.', location.href).href;
    const ws = [];
    for (let k = 0; k < size; k++) ws.push(new Worker(base + 'qa/qa-worker.js'));
    let seq = 0;
    const ask = (w, msg) => new Promise((res, rej) => {
      const id = ++seq;
      const on = e => {
        if (!e.data || e.data.id !== id) return;
        w.removeEventListener('message', on);
        if (e.data.qa === 'done') res(e.data.out); else rej(new Error(e.data.error));
      };
      w.addEventListener('message', on);
      w.addEventListener('error', ev => rej(new Error('워커 오류: ' + (ev.message || ''))), { once: true });
      w.postMessage({ ...msg, qa: 'jobs', id, base });
    });
    // jobs: [[스테이지, 정책, 시드]] → 같은 순서로 결과. 일이 끝난 워커가 다음 일을 가져감
    // extra: 모든 일에 붙일 값 (예: { patch: [[18, { seed: 15 }]] }) 또는 일 번호 → 값 함수
    const run = async (jobs, extra = {}) => {
      const out = new Array(jobs.length);
      let next = 0;
      await Promise.all(ws.map(async w => {
        while (next < jobs.length) {
          const j = next++;
          out[j] = (await ask(w, { jobs: [jobs[j]], ...(typeof extra === 'function' ? extra(j) : extra) }))[0];
        }
      }));
      return out;
    };
    return { run, ask: (msg) => ask(ws[0], msg), close: () => ws.forEach(w => w.terminate()), size };
  }
  // ---- 밸런스 이슈 빠른 수정: 레슨 목표를 벗어난 스테이지의 seed 를 워커로 다시 찾기 ----
  //  await FunctionalQA.fixLessons()                 // 레슨 점검을 돌려 실패한 스테이지를 모두 찾아 seed 후보 제안
  //  await FunctionalQA.fixLessons({ stages: [19] }) // 스테이지 번호(1부터) 지정
  //  옵션: seeds (후보 seed 목록, 기본 1~40), runs (후보 거르기 판 수, 기본 8 = QA와 같음), confirm (재확인 판 수, 기본 24)
  //  결과: [{ stage, seed: 지금 seed, now: 지금 실패율, pick: { seed, stat } | null, candidates }] — pick 을 balance.js 에 적으면 됨.
  //  pick 이 null 이면 seed 만으로는 안 됨 → 그림(그리드)이나 스테이지 의도(qa.engine 목표 구간·gen 손잡이)를 바꾸는 단계로.
  async function fixLessons(opt = {}) {
    const t0 = performance.now();
    const n = opt.runs || 8, nc = opt.confirm || 24;
    const seeds = opt.seeds || Array.from({ length: 40 }, (_, k) => k + 1);
    const pool = makePool(opt.workers || Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 1)));
    const stat = async (i, seed, runs) => {   // seed 를 바꿔서 정책마다 runs 판 → 실패율
      const ks = lessonKeys(i).map(k => k.slice(0, -4)), jobs = [];
      for (const p of ks) for (let s = 0; s < runs; s++) jobs.push([i, p, s * 31 + 7]);
      const out = await pool.run(jobs, seed == null ? {} : { patch: [[i, { seed }]] });
      const r = {};
      for (const p of ks) { let f = 0; out.forEach((st, j) => { if (jobs[j][1] === p && st !== 'clear') f++; }); r[p + 'Fail'] = +(f / runs).toFixed(2); }
      return r;
    };
    const q = i => STAGES[i].qa.engine;
    const pass = (i, r) => lessonKeys(i).every(k => !q(i)[k] || (r[k] >= q(i)[k][0] - 1e-9 && r[k] <= q(i)[k][1] + 1e-9));
    const off = (i, r) => lessonKeys(i).reduce((t, k) => t + (q(i)[k] ? Math.abs(r[k] - (q(i)[k][0] + q(i)[k][1]) / 2) : 0), 0);   // 목표 구간 가운데에서 먼 정도
    const report = [];
    try {
      let stages = opt.stages ? opt.stages.map(s => s - 1) : lessonStages();
      const now = {};
      for (const i of stages) now[i] = await stat(i, null, n);
      if (!opt.stages) stages = stages.filter(i => !pass(i, now[i]));   // 지정 안 하면 실패한 스테이지만
      for (const i of stages) {
        const cands = [];
        for (let b = 0; b < seeds.length; b += 8) {   // 8개씩: 판들을 워커에 한꺼번에 나눠 줌
          const part = seeds.slice(b, b + 8).filter(sd => sd !== STAGES[i].seed);
          const rs = await Promise.all(part.map(sd => stat(i, sd, n)));
          part.forEach((sd, k) => { if (pass(i, rs[k])) cands.push({ seed: sd, stat: rs[k] }); });
          if (cands.length >= (opt.enough || 6)) break;
        }
        cands.sort((a, b) => off(i, a.stat) - off(i, b.stat));
        let pick = null;
        for (const c of cands.slice(0, 3)) {   // 판 수를 늘려 재확인 (8판에서만 운 좋게 통과한 seed 거르기)
          const r = await stat(i, c.seed, nc);
          c.confirm = r;
          if (pass(i, r)) { pick = { seed: c.seed, stat: r }; break; }
        }
        report.push({ stage: i + 1, seed: STAGES[i].seed, now: now[i], target: q(i), pick, candidates: cands });
      }
    } finally { pool.close(); }
    report.ms = Math.round(performance.now() - t0);
    return report;
  }
  function lessonStat(i, n = 8, policies = ['random', 'greedy', 'full']) {
    const out = {};
    for (const p of policies) { let f = 0; for (let s = 0; s < n; s++) if (lessonRun(i, p, s * 31 + 7) !== 'clear') f++; out[p + 'Fail'] = +(f / n).toFixed(2); }
    return out;
  }
  // 레슨(엔진) 목표가 있는 스테이지 번호들
  const lessonStages = () => STAGES.map((s, i) => i).filter(i => i < BASE_COUNT && STAGES[i].qa && STAGES[i].qa.engine);
  const lessonKeys = i => Object.keys(STAGES[i].qa.engine).filter(k => k.endsWith('Fail'));
  function checkLesson(i, r) {
    const q = STAGES[i].qa.engine;
    const inR = (v, a) => !a || (v >= a[0] - 1e-9 && v <= a[1] + 1e-9);
    for (const k of lessonKeys(i))
      check(`스테이지 ${i + 1} 레슨(엔진) ${k} ${JSON.stringify(q[k] || '-')}`, inR(r[k], q[k]), JSON.stringify(r));
  }
  function testLessons(n) { for (const i of lessonStages()) checkLesson(i, lessonStat(i, n, lessonKeys(i).map(k => k.slice(0, -4)))); }

  async function run(opt = {}) {
    results.length = 0;
    const backup = {};
    for (const k of ['antPuzzleCleared', 'antPuzzleLast', 'antPuzzleSpeed', 'antPuzzleMode', 'antPuzzleBoosters']) backup[k] = store.get(k);
    const keep = { cleared, lastStage, speed, mode, inv: { ...inventory } };
    const errors = [];
    const timings = [];   // 단계별 걸린 시간 (ms) — 페이지를 오래 붙잡는 단계 찾기용
    const step = async (name, fn) => {
      const t0 = performance.now();
      try { fn(); } catch (e) { errors.push(name + ': ' + (e && e.stack || e)); check(`${name} 예외 없음`, false, e && e.message); }
      timings.push([name, Math.round(performance.now() - t0)]);
      await new Promise(r => setTimeout(r, 0));
    };
    await step('밸런스 표', testBalanceTable);
    // 스테이지 생성도 52개를 한 번에 돌리면 약 19초 멈추므로 10개씩 나눔
    if (opt.generation !== false) for (let s = 0; s < BASE_COUNT; s += 10) await step(`스테이지 생성 ${s + 1}~`, () => testGeneration(s, Math.min(BASE_COUNT, s + 10)));
    const play = opt.play || STAGES.map((s, i) => i).filter(i => i < BASE_COUNT && (i < 3 || STAGES[i].tier === 'hard' || STAGES[i].tier === 'boss'));
    for (const i of play) await step(`엔진 ${i + 1}`, () => testEngine([i]));
    await step('부스터', testBoosters);
    await step('기믹', testGimmicks);
    await step('보상', testRewards);
    // 레슨은 실행이 수백 번이라 스테이지·정책마다 나눠서 돌림 (한 번에 돌리면 몇 분 동안 페이지가 멈춤)
    // 워커가 있으면 판들을 CPU 코어 수만큼 나눠 돌림 (결과는 같고 시간만 줄어듦). opt.workers = 0 이면 예전처럼 페이지 안에서
    let pool = null;
    const nW = opt.workers != null ? opt.workers : Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
    if (opt.lessons !== false && nW > 0 && typeof Worker === 'function' && lessonStages().length) {
      const t0 = performance.now();
      try {
        pool = makePool(nW);
        // 워커 결과 = 페이지 결과 확인 (첫 레슨 스테이지 한 판을 양쪽에서 돌려 지문 비교)
        const i0 = lessonStages()[0], p0 = lessonKeys(i0)[0].slice(0, -4);
        const wp = (await pool.ask({ jobs: [[i0, p0, 7]], print: true }))[0];
        const pp = lessonPrint(i0, p0, 7);
        if (!check('레슨 워커 결과 = 페이지 결과 (지문)', JSON.stringify(wp) === JSON.stringify(pp), `워커 ${JSON.stringify(wp)} / 페이지 ${JSON.stringify(pp)}`)) { pool.close(); pool = null; }
      } catch (e) {
        errors.push('레슨 워커 준비: ' + (e && e.stack || e));
        if (pool) pool.close();
        pool = null;
      }
      timings.push(['레슨 워커 준비', Math.round(performance.now() - t0)]);
    }
    if (opt.lessons !== false) for (const i of lessonStages()) {
      const r = {}, n = opt.lessonRuns || 8;
      if (pool) {
        const t0 = performance.now();
        const ks = lessonKeys(i).map(k => k.slice(0, -4)), jobs = [];
        for (const p of ks) for (let s = 0; s < n; s++) jobs.push([i, p, s * 31 + 7]);
        try {
          const out = await pool.run(jobs);
          for (const p of ks) {
            let f = 0;
            out.forEach((st, j) => { if (jobs[j][1] === p && st !== 'clear') f++; });
            r[p + 'Fail'] = +(f / n).toFixed(2);
          }
        } catch (e) { errors.push(`레슨 ${i + 1} (워커): ` + (e && e.stack || e)); check(`레슨 ${i + 1} 워커 예외 없음`, false, e && e.message); }
        timings.push([`레슨 ${i + 1} (워커 ${pool.size}개)`, Math.round(performance.now() - t0)]);
        await new Promise(res => setTimeout(res, 0));
      } else {
        for (const k of lessonKeys(i)) await step(`레슨 ${i + 1} ${k}`, () => Object.assign(r, lessonStat(i, n, [k.slice(0, -4)])));
      }
      checkLesson(i, r);
    }
    if (pool) pool.close();
    // 복구
    for (const k in backup) if (backup[k] != null) store.set(k, backup[k]);
    cleared = keep.cleared; lastStage = keep.lastStage; speed = keep.speed; mode = keep.mode; inventory = keep.inv; saveInventory(); saveProgress();
    goMenu();
    const failed = results.filter(r => !r.ok);
    return { total: results.length, passed: results.length - failed.length, failed, errors, timings };
  }

  window.FunctionalQA = { run, countInvariant, borderHits, runEngine, lessonRun, lessonPrint, lessonStat, testLessons, makePool, fixLessons, results };
})();
