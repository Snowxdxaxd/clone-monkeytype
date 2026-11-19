// «Клавиши» — клон Monkeytype: тесты печати, античит-валидация, лидерборд, гонки по WS.
import { createApp, json, badRequest } from './lib/http.mjs';
import { migrate, db, uid } from './lib/db.mjs';
import { ensureAuthTables, loginByName, currentUser } from './lib/auth.mjs';
import { setupWs, sendTo, broadcast } from './lib/ws.mjs';
import { WORDS } from './public/js/words.js';

migrate([
  {
    id: '001-init',
    sql: `
      create table if not exists users (
        id text primary key,
        name text not null,
        created integer not null
      );
      create table if not exists results (
        id text primary key,
        name text not null,
        mode text not null,
        config integer not null,
        wpm real not null,
        raw_wpm real not null,
        accuracy real not null,
        chars_json text not null,
        samples_json text not null,
        elapsed_ms integer not null,
        validated integer not null default 0,
        race text,
        created integer not null
      );
      create index if not exists idx_results_board on results(mode, config, validated, wpm desc);
    `,
  },
]);
ensureAuthTables(db);

const app = createApp({ publicDir: 'public', spa: true });

const TIME_CONFIGS = [15, 30, 60, 120];
const WORDS_CONFIGS = [10, 25, 50];
const RACE_WORDS = 50;

// ---------- сид ----------
function seedSamples(target, secs) {
  const out = [];
  for (let t = 1; t <= secs; t++) {
    const frac = t / secs;
    let w = Math.round(target * (0.55 + 0.45 * frac) * (0.95 + Math.random() * 0.08));
    if (t === secs) w = target;
    w = Math.min(w, target + 2);
    const raw = w + 4 + Math.round(Math.random() * 8);
    out.push({ t, wpm: w, raw });
  }
  return out;
}

function insertSeed() {
  if (db.prepare('select count(*) as c from results').get().c > 0) return;
  const ins = db.prepare(
    `insert into results(id, name, mode, config, wpm, raw_wpm, accuracy, chars_json, samples_json, elapsed_ms, validated, race, created)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const people = [['Мира', 78], ['Даша', 71], ['Артём', 65], ['Лёша', 52], ['Гость', 44]];
  let i = 0;
  for (const [name, wpm] of people) {
    const secs = 30;
    const correct = Math.round((wpm * 5 * secs) / 60);
    const incorrect = 4 + i * 2;
    const extra = 1 + (i % 2);
    const accuracy = +((100 * correct) / (correct + incorrect + extra)).toFixed(2);
    const raw = +(((correct + incorrect + extra) * 60) / (5 * secs)).toFixed(1);
    ins.run(
      uid('r_'), name, 'time', 30, wpm, raw, accuracy,
      JSON.stringify({ correct, incorrect, extra }),
      JSON.stringify(seedSamples(wpm, secs)),
      secs * 1000, 1, null, Date.now() - ++i * 3600e3
    );
  }
  // заведомо невалидная запись: wpm 400 не проходит проверку «wpm ≤ 240»
  const secs = 30;
  const correct = Math.round((400 * 5 * secs) / 60);
  ins.run(
    uid('r_'), 'Читер', 'time', 30, 400, 401.2, 99.8,
    JSON.stringify({ correct, incorrect: 2, extra: 0 }),
    JSON.stringify(seedSamples(400, secs)),
    secs * 1000, 0, null, Date.now() - 3600e3
  );
  console.log('seed: результаты добавлены');
}
insertSeed();

// ---------- auth ----------
app.post('/api/login', (ctx) => {
  const user = loginByName(db, ctx.res, ctx.body.name);
  if (!user) return json(ctx.res, 400, { error: 'need_name' });
  json(ctx.res, 200, { user: { id: user.id, name: user.name } });
});

app.get('/api/me', (ctx) => {
  const u = currentUser(db, ctx);
  json(ctx.res, 200, { user: u ? { id: u.id, name: u.name } : null });
});

// ---------- результаты и античит ----------
// Проверки: окно времени по режиму, границы wpm/accuracy, сходимость wpm с сэмплами и с символами.
function validateResult(r) {
  const reasons = [];
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);

  if (r.mode !== 'time' && r.mode !== 'words') reasons.push('mode');
  else if (!TIME_CONFIGS.includes(r.config) && !WORDS_CONFIGS.includes(r.config)) reasons.push('config');
  else if (r.mode === 'time' && !TIME_CONFIGS.includes(r.config)) reasons.push('config');
  else if (r.mode === 'words' && !WORDS_CONFIGS.includes(r.config)) reasons.push('config');

  const elapsedOk = fin(r.elapsedMs) && r.elapsedMs > 0 && r.elapsedMs <= 3600000;
  if (!elapsedOk) reasons.push('elapsed');
  else if (r.mode === 'time' && !r.race) {
    if (Math.abs(r.elapsedMs - r.config * 1000) > 2000) reasons.push('elapsed_window');
  } else if (r.mode === 'words' || r.race) {
    if (r.elapsedMs < 3000 || r.elapsedMs > 600000) reasons.push('elapsed_window');
  }

  if (!fin(r.wpm) || r.wpm < 0 || r.wpm > 240) reasons.push('wpm');
  if (!fin(r.accuracy) || r.accuracy < 0 || r.accuracy > 100) reasons.push('accuracy');
  if (!fin(r.rawWpm) || r.rawWpm < 0 || r.rawWpm > 600) reasons.push('raw_wpm');

  const c = r.chars || {};
  const nums = [c.correct, c.incorrect, c.extra];
  if (!nums.every(fin) || nums.some((n) => n < 0) || nums.reduce((a, b) => a + b, 0) > 200000) {
    reasons.push('chars');
  } else if (elapsedOk) {
    const charsWpm = c.correct / 5 / (r.elapsedMs / 60000);
    if (Math.abs(r.wpm - charsWpm) > 5) reasons.push('wpm_chars_mismatch');
  }

  let lastW = null;
  for (const s of r.samples) if (s && fin(s.wpm)) lastW = s.wpm;
  if (lastW === null) reasons.push('samples_empty');
  else if (Math.abs(r.wpm - lastW) > 3) reasons.push('wpm_samples_mismatch');

  return reasons;
}

app.post('/api/results', (ctx) => {
  const b = ctx.body || {};
  const user = currentUser(db, ctx);
  const name = String((user && user.name) || b.name || 'Гость').trim().slice(0, 32) || 'Гость';
  const rec = {
    name,
    mode: b.mode === 'words' ? 'words' : b.mode === 'time' ? 'time' : String(b.mode || ''),
    config: Number(b.config),
    wpm: Number(b.wpm),
    rawWpm: Number(b.rawWpm),
    accuracy: Number(b.accuracy),
    chars: {
      correct: Number(b.chars && b.chars.correct),
      incorrect: Number(b.chars && b.chars.incorrect),
      extra: Number(b.chars && b.chars.extra),
    },
    samples: Array.isArray(b.samples) ? b.samples.slice(0, 2000) : [],
    elapsedMs: Number(b.elapsedMs),
    race: b.race ? String(b.race).toUpperCase().trim().slice(0, 6) : null,
  };
  const reasons = validateResult(rec);
  const validated = reasons.length ? 0 : 1;
  const id = uid('r_');
  db.prepare(
    `insert into results(id, name, mode, config, wpm, raw_wpm, accuracy, chars_json, samples_json, elapsed_ms, validated, race, created)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, rec.name, rec.mode,
    Number.isFinite(rec.config) ? Math.round(rec.config) : 0,
    Number.isFinite(rec.wpm) ? rec.wpm : 0,
    Number.isFinite(rec.rawWpm) ? rec.rawWpm : 0,
    Number.isFinite(rec.accuracy) ? rec.accuracy : 0,
    JSON.stringify(rec.chars),
    JSON.stringify(rec.samples.map((s) => ({ t: Number(s && s.t) || 0, wpm: Number(s && s.wpm) || null, raw: Number(s && s.raw) || null }))),
    Number.isFinite(rec.elapsedMs) ? Math.round(rec.elapsedMs) : 0,
    validated, rec.race, Date.now()
  );
  json(ctx.res, 200, { id, validated, reasons });
});

app.get('/api/leaderboard', (ctx) => {
  const mode = ctx.query.get('mode');
  const config = Number(ctx.query.get('config'));
  if ((mode !== 'time' && mode !== 'words') || !Number.isFinite(config)) {
    return badRequest(ctx.res, 'bad_params');
  }
  const rows = db.prepare(
    `select name, mode, config, wpm, raw_wpm as rawWpm, accuracy, elapsed_ms as elapsedMs, race, created
     from results where mode = ? and config = ? and validated = 1
     order by wpm desc limit 20`
  ).all(mode, config);
  json(ctx.res, 200, { rows });
});

// ---------- гонки (комнаты в памяти) ----------
const rooms = new Map();
const RACE_TIMEOUT = 180000;
const ROOM_KEEP = 10 * 60e3;

function makeCode() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += A[(Math.random() * A.length) | 0];
    if (!rooms.has(c)) return c;
  }
}

function pickRaceWords(lang, n) {
  const list = WORDS[lang] || WORDS.ru;
  const out = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    let w = prev;
    for (let k = 0; k < 8 && w === prev; k++) w = list[(Math.random() * list.length) | 0];
    out.push(w);
    prev = w;
  }
  return out;
}

function roomPlayers(room) {
  return [...room.players.values()].map((p) => ({
    name: p.name, progress: p.progress, wpm: p.wpm, accuracy: p.accuracy,
    finished: p.finished, finishedAt: p.finishedAt,
  }));
}

function broadcastLobby(room) {
  broadcast(room.sockets, 'race:lobby', {
    code: room.code, state: room.state,
    players: roomPlayers(room).map((p) => ({ name: p.name, finished: p.finished })),
  });
}

function broadcastProgress(room, force = false) {
  const t = Date.now();
  if (!force && t - room.lastProgress < 100) return;
  room.lastProgress = t;
  broadcast(room.sockets, 'race:progress', { code: room.code, players: roomPlayers(room) });
}

function clearRoomTimers(room) {
  clearTimeout(room.countTimer);
  clearTimeout(room.finishTimer);
  clearTimeout(room.cleanupTimer);
}

function finishRoom(room) {
  if (room.state === 'finished') return;
  clearTimeout(room.countTimer);
  clearTimeout(room.finishTimer);
  room.state = 'finished';
  const results = roomPlayers(room).sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (b.progress !== a.progress) return b.progress - a.progress;
    return b.wpm - a.wpm;
  });
  broadcast(room.sockets, 'race:finished', { code: room.code, results });
  room.cleanupTimer = setTimeout(() => rooms.delete(room.code), ROOM_KEEP);
}

function startCountdown(room) {
  room.state = 'countdown';
  const tick = (n) => {
    broadcast(room.sockets, 'race:countdown', { code: room.code, n });
    if (n > 1) {
      room.countTimer = setTimeout(() => tick(n - 1), 1000);
      return;
    }
    room.countTimer = setTimeout(() => {
      room.words = pickRaceWords(room.lang, RACE_WORDS);
      room.state = 'running';
      room.startedAt = Date.now();
      room.lastProgress = 0;
      broadcast(room.sockets, 'race:started', {
        code: room.code, words: room.words, startTime: room.startedAt, lang: room.lang,
      });
      room.finishTimer = setTimeout(() => finishRoom(room), RACE_TIMEOUT);
    }, 1000);
  };
  tick(3);
}

function joinRoom(ws, room, name) {
  room.players.set(ws.wsId, {
    ws, name, progress: 0, wpm: 0, accuracy: 0, chars: null, finished: false, finishedAt: null,
  });
  room.sockets.add(ws);
  ws.raceCode = room.code;
}

function leaveRoom(ws) {
  const code = ws.raceCode;
  if (!code) return;
  ws.raceCode = null;
  const room = rooms.get(code);
  if (!room) return;
  room.players.delete(ws.wsId);
  room.sockets.delete(ws);
  if (room.players.size === 0) {
    clearRoomTimers(room);
    rooms.delete(code);
    return;
  }
  if (room.state === 'waiting') {
    broadcastLobby(room);
  } else if (room.state === 'countdown') {
    clearTimeout(room.countTimer);
    room.state = 'waiting';
    broadcastLobby(room);
  } else {
    broadcastProgress(room, true);
    if (room.state === 'running' && [...room.players.values()].every((p) => p.finished)) {
      finishRoom(room);
    }
  }
}

function onConn(ws) {
  ws.wsId = uid('w_');
  ws.on('message', (raw) => {
    if (raw.length > 65536) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handleWs(ws, msg); } catch (e) { console.error('ws handler:', e); }
  });
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
}

function handleWs(ws, msg) {
  const t = msg.type;
  const getName = () => String(msg.name || ws.name || 'Гость').trim().slice(0, 16) || 'Гость';

  if (t === 'race:create') {
    leaveRoom(ws);
    ws.name = getName();
    const room = {
      code: makeCode(), state: 'waiting', players: new Map(), sockets: new Set(),
      lang: msg.lang === 'en' ? 'en' : 'ru', words: [], startedAt: 0, lastProgress: 0,
    };
    rooms.set(room.code, room);
    joinRoom(ws, room, ws.name);
    sendTo(ws, 'race:created', { code: room.code, lang: room.lang });
    broadcastLobby(room);
  } else if (t === 'race:join') {
    leaveRoom(ws);
    const code = String(msg.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room || room.state !== 'waiting') {
      return sendTo(ws, 'race:error', { message: 'Комната не найдена или гонка уже началась' });
    }
    ws.name = getName();
    if (msg.lang === 'ru' || msg.lang === 'en') room.lang = msg.lang;
    joinRoom(ws, room, ws.name);
    sendTo(ws, 'race:joined', { code: room.code, lang: room.lang });
    broadcastLobby(room);
  } else if (t === 'race:start') {
    const room = rooms.get(ws.raceCode);
    if (!room || room.state !== 'waiting' || room.players.size < 1) return;
    startCountdown(room);
  } else if (t === 'race:progress') {
    const room = rooms.get(ws.raceCode);
    if (!room || room.state !== 'running') return;
    const p = room.players.get(ws.wsId);
    if (!p || p.finished) return;
    const chars = Number(msg.chars);
    if (Number.isFinite(chars)) p.progress = Math.max(0, Math.round(chars));
    const w = Number(msg.wpm);
    if (Number.isFinite(w)) p.wpm = Math.min(400, Math.max(0, w));
    const a = Number(msg.accuracy);
    if (Number.isFinite(a)) p.accuracy = Math.min(100, Math.max(0, a));
    broadcastProgress(room);
  } else if (t === 'race:finish') {
    const room = rooms.get(ws.raceCode);
    if (!room || room.state !== 'running') return;
    const p = room.players.get(ws.wsId);
    if (!p || p.finished) return;
    const w = Number(msg.wpm);
    if (Number.isFinite(w)) p.wpm = Math.min(400, Math.max(0, w));
    const a = Number(msg.accuracy);
    if (Number.isFinite(a)) p.accuracy = Math.min(100, Math.max(0, a));
    const ch = msg.chars || {};
    p.chars = {
      correct: Number(ch.correct) || 0,
      incorrect: Number(ch.incorrect) || 0,
      extra: Number(ch.extra) || 0,
    };
    p.progress = Math.max(p.progress, p.chars.correct);
    p.finished = true;
    p.finishedAt = Date.now() - room.startedAt;
    broadcastProgress(room, true);
    if ([...room.players.values()].every((x) => x.finished)) finishRoom(room);
  } else if (t === 'race:leave') {
    leaveRoom(ws);
    sendTo(ws, 'race:left', {});
  } else if (t === 'ping') {
    sendTo(ws, 'pong', { t: msg.t || 0 });
  }
}

const PORT = process.env.PORT || 3020;
app.listen(PORT, (server) => setupWs(server, /^\/ws$/, onConn));
