// =====================================================================
//  기능 QA 레슨 판을 여러 CPU 코어에서 나눠 돌리는 웹 워커
//  (qa/functional-qa.js 의 run() 이 만들어 씀. 게임 진행에는 영향 없음)
//  index.html 의 게임 스크립트를 그대로 불러오고, 화면·소리·저장소는 빈 껍데기로 대신한다.
//  → 같은 (스테이지, 정책, 시드)면 페이지 안에서 돌린 것과 똑같은 결과가 나와야 함 (QA가 지문으로 확인)
// =====================================================================
'use strict';
self.window = self;
const noop = () => {};
const el = () => ({ style: {}, addEventListener: noop, removeEventListener: noop, click: noop, appendChild: noop, remove: noop });
const canvas = (w = 1, h = 1) => {
  const c = new OffscreenCanvas(w, h);
  c.style = {}; c.addEventListener = noop; c.removeEventListener = noop;
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 420, height: 800 });
  return c;
};
const mainCanvas = canvas(420, 800);
self.document = {
  getElementById: id => id === 'c' ? mainCanvas : el(),
  createElement: t => t === 'canvas' ? canvas() : el(),
  addEventListener: noop, body: el(), fonts: null, hidden: true,
};
const mem = new Map();
self.localStorage = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
self.innerWidth = 420; self.innerHeight = 800; self.devicePixelRatio = 1;
self.requestAnimationFrame = noop;   // 게임 루프는 돌리지 않음 (QA가 update를 직접 부름)
self.prompt = () => null;
self.Image = function () {};

let ready = null;
const undo = [];   // patch 로 바꾼 값 [스테이지, 키, 원래 값]
async function boot(base) {
  importScripts(base + 'balance/balance.js');
  const html = await (await fetch(base + 'index.html', { cache: 'no-store' })).text();
  // 게임 본체 = 이름 없는 <script> 중 가장 긴 것
  const bodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const game = bodies.sort((a, b) => b.length - a.length)[0];
  importScripts(URL.createObjectURL(new Blob([game], { type: 'text/javascript' })));
  importScripts(base + 'qa/functional-qa.js');
}

self.onmessage = async e => {
  const m = e.data;
  if (!m || m.qa !== 'jobs') return;   // 게임 스크립트가 단 'message' 리스너와 섞이지 않게
  try {
    ready = ready || boot(m.base);
    await ready;
    // patch: [[스테이지 번호(0부터), { seed: … }]] — 밸런스 seed 찾기용. 이 메시지 동안만 바꾸고 다음 메시지 전에 되돌림
    for (const [i, k, v] of undo.splice(0)) STAGES[i][k] = v;
    for (const [i, p] of m.patch || []) for (const k in p) { undo.push([i, k, STAGES[i][k]]); STAGES[i][k] = p[k]; }
    const out = [];
    for (const [i, p, s] of m.jobs) out.push(m.print ? self.FunctionalQA.lessonPrint(i, p, s) : self.FunctionalQA.lessonRun(i, p, s));
    self.postMessage({ qa: 'done', id: m.id, out });
  } catch (err) {
    self.postMessage({ qa: 'error', id: m.id, error: String(err && err.stack || err) });
  }
};
