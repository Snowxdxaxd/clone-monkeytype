// «Клавиши» — клиент: движок печати, результаты, лидерборд, гонки.
import { WORDS } from './words.js';

const $ = (id) => document.getElementById(id);

function pickWord(lang, prev) {
  const list = WORDS[lang] || WORDS.ru;
  let w = prev;
  for (let i = 0; i < 8 && w === prev; i++) w = list[(Math.random() * list.length) | 0];
  return w;
}

// ---------- движок печати ----------
// Учитывает верные/неверные/лишние символы, сэмплы по секундам, перевод строк ленты и каретку.
class TypingEngine {
  constructor(opts) {
    this.feedInner = opts.feedInner;
    this.caret = opts.caretEl;
    this.liveEl = opts.liveEl;
    this.infinite = !!opts.infinite;
    this.onFinish = opts.onFinish || null;
    this.onProgress = opts.onProgress || null;
    this.mode = opts.mode || 'time';
    this.config = opts.config || 30;
    this.lang = opts.lang || 'ru';
    this.lineH = 0;
    this.feedInner.appendChild(this.caret);
    this.reset();
  }

  setConfig(mode, config, lang) {
    this.mode = mode;
    this.config = config;
    this.lang = lang;
  }

  reset(words) {
    clearInterval(this.timer);
    clearInterval(this.sampler);
    clearInterval(this.progressTimer);
    this.timer = this.sampler = this.progressTimer = null;
    if (words) {
      this.words = words.slice();
    } else {
      this.words = [];
      const n = this.mode === 'time' ? 45 : this.config;
      let prev = null;
      for (let i = 0; i < n; i++) {
        const w = pickWord(this.lang, prev);
        this.words.push(w);
        prev = w;
      }
    }
    this.typed = this.words.map(() => []);
    this.wi = 0;
    this.started = false;
    this.finished = false;
    this.correct = 0;
    this.incorrect = 0;
    this.extra = 0;
    this.samples = [];
    this.t0 = 0;
    this.nextSample = 1000;
    this.finalElapsed = 0;
    this.result = null;
    this.feedInner.innerHTML = '';
    this.feedInner.appendChild(this.caret);
    this.wordEls = [];
    for (let i = 0; i < this.words.length; i++) this.renderWord(i);
    if (this.wordEls[0]) this.wordEls[0].classList.add('active');
    this.feedInner.style.transform = 'translateY(0)';
    this.lineH = 0;
    this.relayout();
  }

  relayout() {
    this.scroll();
    this.updateCaret();
    this.renderLive();
  }

  ensureWords() {
    if (this.mode !== 'time') return;
    const before = this.wordEls.length;
    while (this.words.length < this.wi + 30) {
      this.words.push(pickWord(this.lang, this.words[this.words.length - 1]));
      this.typed.push([]);
    }
    for (let i = before; i < this.words.length; i++) this.renderWord(i);
  }

  start() {
    this.started = true;
    this.t0 = performance.now();
    if (this.mode === 'time') {
      this.timer = setInterval(() => {
        if (this.finished) return;
        if (this.elapsed() >= this.config * 1000) {
          this.finish();
          return;
        }
        this.renderLive();
      }, 200);
    }
    this.sampler = setInterval(() => {
      if (this.finished) return;
      const el = this.elapsed();
      while (this.nextSample <= el) {
        this.pushSample(this.nextSample);
        this.nextSample += 1000;
      }
      this.renderLive();
    }, 250);
    if (this.onProgress) {
      this.progressTimer = setInterval(() => {
        if (!this.finished && this.started) this.onProgress(this);
      }, 500);
    }
  }

  elapsed() {
    return this.finished ? this.finalElapsed : performance.now() - this.t0;
  }

  pushSample(tMs) {
    const min = tMs / 60000;
    const wpm = this.correct / 5 / min;
    const raw = (this.correct + this.incorrect + this.extra) / 5 / min;
    this.samples.push({ t: tMs / 1000, wpm: +wpm.toFixed(2), raw: +raw.toFixed(2) });
  }

  handleKey(e) {
    if (this.finished) return false;
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (this.started) this.backspace();
      return true;
    }
    if (e.key.length !== 1) return false;
    const ch = e.key;
    if (!this.started) this.start();
    if (ch === ' ') {
      e.preventDefault();
      this.space();
    } else {
      this.addChar(ch);
    }
    return true;
  }

  addChar(ch) {
    this.ensureWords();
    if (!this.typed[this.wi]) this.typed[this.wi] = [];
    const w = this.words[this.wi];
    const t = this.typed[this.wi];
    const k = t.length;
    const st = k >= w.length ? 'extra' : ch === w[k] ? 'ok' : 'bad';
    t.push({ ch, st });
    if (st === 'ok') this.correct++;
    else if (st === 'bad') this.incorrect++;
    else this.extra++;
    this.renderWord(this.wi);
    this.afterInput(this.wi);
    // последний набор: тест на слова завершается вводом последнего слова (пробел не обязателен)
    if (this.mode === 'words' && this.wi === this.words.length - 1 && t.length >= w.length) {
      this.finish();
    }
  }

  space() {
    const t = this.typed[this.wi] || [];
    if (t.length === 0) return;
    const oldWi = this.wi;
    this.correct++;
    if (this.mode === 'words' && this.wi === this.words.length - 1) {
      this.afterInput(oldWi);
      this.finish();
      return;
    }
    this.wi++;
    this.ensureWords();
    if (!this.typed[this.wi]) this.typed[this.wi] = [];
    this.afterInput(oldWi);
  }

  backspace() {
    const oldWi = this.wi;
    const t = this.typed[this.wi] || [];
    if (t.length > 0) {
      this.decCounter(t.pop().st);
      this.renderWord(this.wi);
      this.afterInput(oldWi);
      return;
    }
    // назад можно перейти только в предыдущее слово, если в нём есть ошибка или лишние символы
    if (this.wi > 0) {
      const prevT = this.typed[this.wi - 1] || [];
      if (prevT.some((x) => x.st !== 'ok')) {
        this.wi--;
        const c = this.typed[this.wi].pop();
        this.decCounter(c.st);
        this.renderWord(this.wi);
        this.afterInput(oldWi);
      }
    }
  }

  decCounter(st) {
    if (st === 'ok') this.correct--;
    else if (st === 'bad') this.incorrect--;
    else this.extra--;
  }

  afterInput(oldWi) {
    if (oldWi !== this.wi) {
      if (this.wordEls[oldWi]) this.wordEls[oldWi].classList.remove('active');
      if (this.wordEls[this.wi]) this.wordEls[this.wi].classList.add('active');
    }
    this.scroll();
    this.updateCaret();
    this.renderLive();
  }

  renderWord(i) {
    let el = this.wordEls[i];
    if (!el) {
      el = document.createElement('div');
      el.className = 'w';
      this.feedInner.appendChild(el);
      this.wordEls[i] = el;
    }
    const w = this.words[i];
    const t = this.typed[i] || [];
    const frag = document.createDocumentFragment();
    for (let j = 0; j < w.length; j++) {
      const s = document.createElement('span');
      s.className = 'c' + (t[j] ? (t[j].st === 'ok' ? ' ok' : ' bad') : '');
      s.textContent = w[j];
      frag.appendChild(s);
    }
    for (let j = w.length; j < t.length; j++) {
      const s = document.createElement('span');
      s.className = 'c extra';
      s.textContent = t[j].ch;
      frag.appendChild(s);
    }
    el.replaceChildren(frag);
  }

  scroll() {
    const el = this.wordEls[this.wi];
    if (!el) return;
    if (!this.lineH) this.lineH = el.offsetHeight || 1;
    const line = Math.round(el.offsetTop / this.lineH);
    const shift = Math.max(0, line - 1);
    this.feedInner.style.transform = `translateY(${-shift * this.lineH}px)`;
  }

  updateCaret() {
    const el = this.wordEls[this.wi];
    if (!el || this.finished) {
      this.caret.classList.add('hidden');
      return;
    }
    this.caret.classList.remove('hidden');
    const chars = el.children;
    const t = this.typed[this.wi] || [];
    const ir = this.feedInner.getBoundingClientRect();
    let r;
    if (chars.length && t.length < chars.length) {
      r = chars[t.length].getBoundingClientRect();
    } else if (chars.length) {
      r = chars[chars.length - 1].getBoundingClientRect();
    } else {
      r = el.getBoundingClientRect();
    }
    const afterEnd = t.length >= chars.length;
    this.caret.style.left = (afterEnd ? r.right : r.left) - ir.left + 'px';
    this.caret.style.top = r.top - ir.top + 'px';
    this.caret.style.height = r.height + 'px';
  }

  renderLive() {
    const el = this.started ? this.elapsed() : 0;
    let wpm = '—';
    let acc = '—';
    if (this.started && el > 500) {
      const min = el / 60000;
      wpm = Math.round((this.correct / 5) / min);
      const sum = this.correct + this.incorrect + this.extra;
      acc = sum > 0 ? Math.round((100 * this.correct) / sum) : 100;
    }
    if (this.mode === 'time') {
      const rem = this.started ? Math.max(0, this.config - Math.floor(el / 1000)) : this.config;
      this.liveEl.textContent = `wpm ${wpm} · точность ${acc}% · осталось ${rem} с`;
    } else {
      this.liveEl.textContent = `wpm ${wpm} · точность ${acc}%`;
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.timer);
    clearInterval(this.sampler);
    clearInterval(this.progressTimer);
    this.timer = this.sampler = this.progressTimer = null;
    this.finalElapsed = this.mode === 'time' ? this.config * 1000 : performance.now() - this.t0;
    const min = Math.max(this.finalElapsed, 1) / 60000;
    const wpm = (this.correct / 5) / min;
    const raw = ((this.correct + this.incorrect + this.extra) / 5) / min;
    const sum = this.correct + this.incorrect + this.extra;
    const accuracy = sum > 0 ? (100 * this.correct) / sum : 100;
    this.samples.push({
      t: +(this.finalElapsed / 1000).toFixed(2),
      wpm: +wpm.toFixed(2),
      raw: +raw.toFixed(2),
    });
    this.result = {
      mode: this.mode,
      config: this.config,
      wpm: +wpm.toFixed(2),
      rawWpm: +raw.toFixed(2),
      accuracy: +accuracy.toFixed(2),
      chars: { correct: this.correct, incorrect: this.incorrect, extra: this.extra },
      samples: this.samples,
      elapsedMs: Math.round(this.finalElapsed),
    };
    this.updateCaret();
    this.renderLive();
    if (this.onFinish) this.onFinish(this);
  }
}

// ---------- график результата ----------
function strokeLine(g, pts, fx, fy, color) {
  g.beginPath();
  pts.forEach((s, i) => {
    const x = fx(s);
    const y = fy(s);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.stroke();
}

function drawChart(canvas, samples) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 220;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const pts = (samples || []).filter((s) => s && Number.isFinite(s.wpm));
  const mono = '11px ui-monospace, Consolas, monospace';
  if (pts.length < 2) {
    g.fillStyle = '#8a90a0';
    g.font = mono;
    g.fillText('Мало данных для графика', 24, 40);
    return;
  }
  const pad = { l: 40, r: 16, t: 16, b: 28 };
  const maxT = pts[pts.length - 1].t || 1;
  const maxV = Math.max(...pts.map((s) => Math.max(s.wpm, s.raw || 0)));
  const yMax = Math.max(20, Math.ceil(maxV / 20) * 20);
  const X = (t) => pad.l + ((t - 1) / Math.max(1, maxT - 1)) * (w - pad.l - pad.r);
  const Y = (v) => h - pad.b - (v / yMax) * (h - pad.t - pad.b);

  g.strokeStyle = 'rgba(138,144,160,0.18)';
  g.lineWidth = 1;
  g.fillStyle = '#5c6270';
  g.font = mono;
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    const y = Y(v);
    g.beginPath();
    g.moveTo(pad.l, y);
    g.lineTo(w - pad.r, y);
    g.stroke();
    g.textAlign = 'right';
    g.fillText(String(Math.round(v)), pad.l - 7, y + 3);
  }
  g.textAlign = 'center';
  const stepT = Math.max(1, Math.ceil(maxT / 8 / 5) * 5);
  for (let t = 1; t <= maxT; t += stepT) {
    g.fillText(String(Math.round(t)), X(t), h - pad.b + 15);
  }
  g.fillText('сек', w - pad.r + 2, h - pad.b + 15);

  // заливка под wpm
  g.beginPath();
  pts.forEach((s, i) => {
    const x = X(s.t);
    const y = Y(s.wpm);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.lineTo(X(pts[pts.length - 1].t), Y(0));
  g.lineTo(X(pts[0].t), Y(0));
  g.closePath();
  g.fillStyle = 'rgba(226,183,20,0.10)';
  g.fill();

  strokeLine(g, pts, (s) => X(s.t), (s) => Y(s.raw || 0), '#8a90a0');
  strokeLine(g, pts, (s) => X(s.t), (s) => Y(s.wpm), '#e2b714');

  g.textAlign = 'left';
  g.font = mono;
  g.fillStyle = '#e2b714';
  g.fillText('wpm', pad.l + 6, pad.t + 2);
  g.fillStyle = '#8a90a0';
  g.fillText('raw', pad.l + 48, pad.t + 2);
}

// ---------- имя / сессия ----------
let me = null;

function currentName() {
  return (me && me.name) || $('nameInput').value.trim() || 'Гость';
}

function flashSaved(kind) {
  const el = $('nameSaved');
  el.textContent = kind === 'ok' ? 'сохранено' : 'ошибка';
  el.style.color = kind === 'ok' ? '' : 'var(--bad)';
  setTimeout(() => { el.textContent = ''; }, 1800);
}

async function saveName() {
  const name = $('nameInput').value.trim();
  if (!name || (me && me.name === name)) return;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.user) {
      me = data.user;
      flashSaved('ok');
    } else {
      flashSaved('fail');
    }
  } catch {
    flashSaved('fail');
  }
}

async function initName() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.user) {
      me = data.user;
      $('nameInput').value = me.name;
    }
  } catch { /* сервер недоступен — работаем анонимно */ }
}

// ---------- вкладка теста ----------
const CONFIGS = { time: [15, 30, 60, 120], words: [10, 25, 50] };
let testMode = 'time';
let testConfig = 30;
let testLang = 'ru';

const testEngine = new TypingEngine({
  feedInner: $('feedInner'),
  caretEl: $('caret'),
  liveEl: $('liveStatus'),
  mode: testMode,
  config: testConfig,
  lang: testLang,
  infinite: true,
  onFinish: onTestFinish,
});

function restartTest() {
  $('resultPanel').classList.add('hidden');
  $('feedWrap').classList.remove('hidden');
  $('liveStatus').classList.remove('hidden');
  $('saveNote').textContent = '';
  testEngine.setConfig(testMode, testConfig, testLang);
  testEngine.reset();
}

function fmtAcc(v) {
  return String(Math.round(v * 10) / 10);
}

function onTestFinish(engine) {
  const r = engine.result;
  $('resWpm').textContent = String(Math.round(r.wpm));
  $('resAcc').textContent = fmtAcc(r.accuracy) + '%';
  $('resRaw').textContent = String(Math.round(r.rawWpm));
  $('resTime').textContent = (r.elapsedMs / 1000).toFixed(r.mode === 'time' ? 0 : 1) + ' с';
  $('resChars').textContent = `${r.chars.correct} / ${r.chars.incorrect} / ${r.chars.extra}`;
  $('feedWrap').classList.add('hidden');
  $('liveStatus').classList.add('hidden');
  $('resultPanel').classList.remove('hidden');
  drawChart($('chart'), r.samples);

  const note = $('saveNote');
  note.textContent = '';
  note.className = 'save-note';
  fetch('/api/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(r),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.validated === 1) {
        note.textContent = 'Результат сохранён';
        note.className = 'save-note ok';
      } else {
        note.textContent = 'Результат не прошёл проверку';
        note.className = 'save-note fail';
      }
    })
    .catch(() => {
      note.textContent = 'Не удалось отправить результат';
      note.className = 'save-note fail';
    });
}

function renderConfigButtons() {
  const box = $('configSwitch');
  box.innerHTML = '';
  for (const c of CONFIGS[testMode]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctrl' + (c === testConfig ? ' active' : '');
    b.textContent = String(c);
    b.addEventListener('click', () => {
      testConfig = c;
      renderConfigButtons();
      restartTest();
    });
    box.appendChild(b);
  }
}

function bindGroup(id, attr, onPick) {
  $(id).querySelectorAll('.ctrl').forEach((b) => {
    b.addEventListener('click', () => {
      $(id).querySelectorAll('.ctrl').forEach((x) => x.classList.toggle('active', x === b));
      onPick(b.dataset[attr]);
    });
  });
}

bindGroup('modeSwitch', 'mode', (mode) => {
  testMode = mode;
  testConfig = CONFIGS[mode][1];
  renderConfigButtons();
  restartTest();
});
bindGroup('langSwitch', 'lang', (lang) => {
  testLang = lang;
  restartTest();
});
bindGroup('boardMode', 'mode', (mode) => {
  boardMode = mode;
  boardConfig = CONFIGS[mode][1];
  renderBoardControls();
  fetchBoard();
});
bindGroup('raceLang', 'lang', (lang) => {
  race.lang = lang;
});

$('btnAgain').addEventListener('click', restartTest);
$('btnBoard').addEventListener('click', openBoard);
$('logoLink').addEventListener('click', (e) => {
  e.preventDefault();
  switchTab('test');
  restartTest();
});

// ---------- вкладки ----------
function switchTab(tab) {
  $('tabTest').classList.toggle('active', tab === 'test');
  $('tabRace').classList.toggle('active', tab === 'race');
  $('viewTest').classList.toggle('hidden', tab !== 'test');
  $('viewRace').classList.toggle('hidden', tab !== 'race');
  if (tab === 'test') restartTest();
}

$('tabTest').addEventListener('click', () => switchTab('test'));
$('tabRace').addEventListener('click', () => switchTab('race'));

// ---------- лидерборд ----------
let boardMode = 'time';
let boardConfig = 30;

function renderBoardControls() {
  document.querySelectorAll('#boardMode .ctrl').forEach((x) => {
    x.classList.toggle('active', x.dataset.mode === boardMode);
  });
  const box = $('boardConfig');
  box.innerHTML = '';
  for (const c of CONFIGS[boardMode]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctrl' + (c === boardConfig ? ' active' : '');
    b.textContent = String(c);
    b.addEventListener('click', () => {
      boardConfig = c;
      renderBoardControls();
      fetchBoard();
    });
    box.appendChild(b);
  }
}

async function fetchBoard() {
  try {
    const res = await fetch(`/api/leaderboard?mode=${boardMode}&config=${boardConfig}`);
    const data = await res.json();
    const rows = data.rows || [];
    const tbody = $('boardTable').querySelector('tbody');
    tbody.innerHTML = '';
    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      const td = (text, cls) => {
        const el = document.createElement('td');
        if (cls) el.className = cls;
        el.textContent = text;
        return el;
      };
      tr.appendChild(td(String(i + 1)));
      tr.appendChild(td(row.name + (row.race ? ' · гонка' : '')));
      tr.appendChild(td(String(Math.round(row.wpm)), 'num'));
      tr.appendChild(td(String(Math.round(row.rawWpm)), 'num'));
      tr.appendChild(td(fmtAcc(row.accuracy) + '%', 'num'));
      tbody.appendChild(tr);
    });
    $('boardEmpty').classList.toggle('hidden', rows.length > 0);
    $('boardTable').classList.toggle('hidden', rows.length === 0);
  } catch {
    $('boardEmpty').classList.remove('hidden');
  }
}

function openBoard() {
  boardMode = testMode;
  boardConfig = testConfig;
  renderBoardControls();
  $('modal').classList.remove('hidden');
  fetchBoard();
}

function closeBoard() {
  $('modal').classList.add('hidden');
}

$('boardClose').addEventListener('click', closeBoard);
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeBoard();
});

// ---------- гонка ----------
const race = {
  code: null,
  phase: 'setup', // setup | lobby | running | finished
  lang: 'ru',
  totalChars: 0,
  myResult: null,
  posted: false,
  autoJoin: null,
};

let ws = null;
let wsOpen = false;
let wsQueue = [];

function wsConnect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    wsOpen = true;
    const queue = wsQueue;
    wsQueue = [];
    for (const m of queue) sendWs(m.type, m.data);
    if (race.autoJoin) {
      const j = race.autoJoin;
      race.autoJoin = null;
      sendWs('race:join', { code: j.code, name: currentName(), lang: race.lang });
    } else if (race.code && race.phase === 'lobby') {
      sendWs('race:join', { code: race.code, name: currentName(), lang: race.lang });
    }
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handleRaceMsg(m);
  };
  ws.onclose = () => {
    wsOpen = false;
    if (race.phase === 'lobby' || race.phase === 'running') {
      setTimeout(() => { if (!wsOpen) wsConnect(); }, 1500);
    }
  };
  ws.onerror = () => {};
}

function sendWs(type, data = {}) {
  if (wsOpen && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...data }));
  } else {
    wsQueue.push({ type, data });
  }
}

const raceEngine = new TypingEngine({
  feedInner: $('raceFeedInner'),
  caretEl: $('raceCaret'),
  liveEl: $('raceLive'),
  mode: 'words',
  config: 50,
  lang: 'ru',
  infinite: false,
  onFinish: onRaceFinish,
  onProgress: onRaceProgress,
});

function onRaceProgress(engine) {
  const min = Math.max(engine.elapsed(), 1) / 60000;
  const wpm = engine.started ? (engine.correct / 5) / min : 0;
  const sum = engine.correct + engine.incorrect + engine.extra;
  const acc = sum > 0 ? (100 * engine.correct) / sum : 100;
  sendWs('race:progress', { chars: engine.correct, wpm: +wpm.toFixed(2), accuracy: +acc.toFixed(2) });
}

function onRaceFinish(engine) {
  race.myResult = { ...engine.result, race: race.code };
  sendWs('race:finish', {
    wpm: engine.result.wpm,
    accuracy: engine.result.accuracy,
    chars: engine.result.chars,
  });
  $('raceWait').classList.remove('hidden');
}

function showRaceLobby() {
  $('raceSetup').classList.add('hidden');
  $('raceRun').classList.add('hidden');
  $('raceLobby').classList.remove('hidden');
  $('lobbyCode').textContent = race.code || '';
  $('raceLink').value = location.origin + '/?race=' + (race.code || '');
  $('raceError').textContent = '';
}

function showRaceRun() {
  $('raceSetup').classList.add('hidden');
  $('raceLobby').classList.add('hidden');
  $('raceRun').classList.remove('hidden');
}

function resetRaceView() {
  race.code = null;
  race.phase = 'setup';
  race.totalChars = 0;
  race.myResult = null;
  race.posted = false;
  $('raceLobby').classList.add('hidden');
  $('raceRun').classList.add('hidden');
  $('raceSetup').classList.remove('hidden');
  raceEngine.reset([]);
}

function renderLobbyPlayers(players) {
  const box = $('racePlayers');
  box.innerHTML = '';
  for (const p of players || []) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const dot = document.createElement('span');
    dot.className = 'dot';
    row.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = p.name;
    row.appendChild(name);
    box.appendChild(row);
  }
  if (!players || players.length === 0) {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.textContent = 'Никого в комнате';
    box.appendChild(row);
  }
}

function renderBars(players) {
  const box = $('raceBars');
  box.innerHTML = '';
  for (const p of players || []) {
    const pct = Math.min(100, Math.round((100 * p.progress) / Math.max(1, race.totalChars)));
    const row = document.createElement('div');
    row.className = 'bar-row' + (p.name === currentName() ? ' me' : '');
    const name = document.createElement('span');
    name.className = 'bname';
    name.textContent = p.name;
    const track = document.createElement('span');
    track.className = 'btrack';
    const fill = document.createElement('span');
    fill.className = 'bfill';
    fill.style.width = pct + '%';
    track.appendChild(fill);
    const val = document.createElement('span');
    val.className = 'bval';
    val.textContent = `${pct}% · ${Math.round(p.wpm)} wpm`;
    row.appendChild(name);
    row.appendChild(track);
    row.appendChild(val);
    box.appendChild(row);
  }
}

function renderRaceResults(results) {
  race.phase = 'finished';
  $('raceWait').classList.add('hidden');
  const tbody = $('raceResultTable').querySelector('tbody');
  tbody.innerHTML = '';
  (results || []).forEach((p, i) => {
    const tr = document.createElement('tr');
    if (p.name === currentName()) tr.className = 'me-row';
    const td = (text, cls) => {
      const el = document.createElement('td');
      if (cls) el.className = cls;
      el.textContent = text;
      return el;
    };
    tr.appendChild(td(String(i + 1)));
    tr.appendChild(td(p.name));
    tr.appendChild(td(String(Math.round(p.wpm)), 'num'));
    tr.appendChild(td(fmtAcc(p.accuracy) + '%', 'num'));
    tr.appendChild(td(String(p.progress), 'num'));
    tbody.appendChild(tr);
  });
  $('raceResultPanel').classList.remove('hidden');

  if (race.myResult && !race.posted) {
    race.posted = true;
    const note = $('raceSaveNote');
    fetch('/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(race.myResult),
    })
      .then((res) => res.json())
      .then((data) => {
        note.textContent = data.validated === 1 ? 'Результат сохранён' : 'Результат не прошёл проверку';
        note.className = 'save-note ' + (data.validated === 1 ? 'ok' : 'fail');
      })
      .catch(() => {
        note.textContent = 'Не удалось отправить результат';
        note.className = 'save-note fail';
      });
  }
}

function handleRaceMsg(m) {
  switch (m.type) {
    case 'race:created':
    case 'race:joined':
      race.code = m.code;
      race.phase = 'lobby';
      showRaceLobby();
      break;
    case 'race:lobby':
      if (m.code && race.code && m.code !== race.code) return;
      renderLobbyPlayers(m.players);
      if (m.state === 'waiting' && race.phase !== 'lobby' && race.code) showRaceLobby();
      break;
    case 'race:countdown':
      showRaceRun();
      race.phase = 'running';
      $('raceCountdown').classList.remove('hidden');
      $('raceCountdown').textContent = String(m.n);
      $('raceResultPanel').classList.add('hidden');
      $('raceFeedWrap').classList.add('hidden');
      $('raceLive').classList.add('hidden');
      $('raceBars').innerHTML = '';
      break;
    case 'race:started':
      showRaceRun();
      race.phase = 'running';
      race.totalChars = (m.words || []).join(' ').length;
      raceEngine.setConfig('words', 50, m.lang || race.lang);
      raceEngine.reset(m.words || []);
      $('raceCountdown').classList.add('hidden');
      $('raceFeedWrap').classList.remove('hidden');
      $('raceLive').classList.remove('hidden');
      $('raceWait').classList.add('hidden');
      $('raceResultPanel').classList.add('hidden');
      race.myResult = null;
      race.posted = false;
      break;
    case 'race:progress':
      renderBars(m.players);
      break;
    case 'race:finished':
      renderRaceResults(m.results);
      break;
    case 'race:error':
      resetRaceView();
      $('raceError').textContent = m.message || 'Ошибка гонки';
      break;
    case 'race:left':
      resetRaceView();
      break;
    default:
      break;
  }
}

$('raceCreate').addEventListener('click', () => {
  $('raceError').textContent = '';
  sendWs('race:create', { name: currentName(), lang: race.lang });
});

$('raceJoin').addEventListener('click', () => {
  const code = $('raceCodeInput').value.trim().toUpperCase();
  if (code.length < 4) {
    $('raceError').textContent = 'Введите код комнаты';
    return;
  }
  $('raceError').textContent = '';
  sendWs('race:join', { code, name: currentName(), lang: race.lang });
});

$('raceCodeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('raceJoin').click();
});

$('raceStart').addEventListener('click', () => sendWs('race:start'));
$('raceLeave').addEventListener('click', () => {
  sendWs('race:leave');
  resetRaceView();
});
$('raceAgain').addEventListener('click', resetRaceView);
$('raceToTest').addEventListener('click', () => {
  resetRaceView();
  switchTab('test');
});
$('raceCopy').addEventListener('click', async () => {
  const input = $('raceLink');
  try {
    await navigator.clipboard.writeText(input.value);
    $('raceCopy').querySelector('span').textContent = 'скопировано';
  } catch {
    input.select();
    document.execCommand('copy');
    $('raceCopy').querySelector('span').textContent = 'скопировано';
  }
  setTimeout(() => { $('raceCopy').querySelector('span').textContent = 'ссылка'; }, 1800);
});

// ---------- имя ----------
$('nameInput').addEventListener('change', saveName);
$('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('nameInput').blur();
  }
});

// ---------- глобальная клавиатура ----------
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!$('modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeBoard();
    return;
  }
  const raceTab = !$('viewRace').classList.contains('hidden');
  if (e.key === 'Tab') {
    if (!raceTab) {
      e.preventDefault();
      restartTest();
    }
    return;
  }
  if (raceTab) {
    if (race.phase === 'running') raceEngine.handleKey(e);
    return;
  }
  if ($('resultPanel').classList.contains('hidden')) testEngine.handleKey(e);
});

window.addEventListener('resize', () => {
  testEngine.relayout();
  if (!$('viewRace').classList.contains('hidden')) raceEngine.relayout();
});

// ---------- запуск ----------
renderConfigButtons();
initName();

// автоприсоединение по ссылке ?race=КОД
const raceParam = new URLSearchParams(location.search).get('race');
if (raceParam) {
  switchTab('race');
  race.autoJoin = { code: raceParam.toUpperCase().trim().slice(0, 6) };
  history.replaceState(null, '', '/');
}

wsConnect();
