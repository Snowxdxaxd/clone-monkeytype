// Дымовой тест гонок: два WS-клиента проходят полный цикл create → join → start → progress → finish → finished.
// Запуск: node scripts/ws-smoke.mjs (сервер должен быть поднят на PORT, по умолчанию 3020).
import WebSocket from 'ws';

const PORT = process.env.PORT || 3020;
const URL = `ws://127.0.0.1:${PORT}/ws`;

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
  if (!cond) failures++;
};

const waitMsg = (ws, type, timeout = 8000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting ' + type));
    }, timeout);
    const h = (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === type) {
        cleanup();
        resolve(m);
      }
    };
    const cleanup = () => {
      clearTimeout(t);
      ws.off('message', h);
    };
    ws.on('message', h);
  });

const waitLobby = async (ws, minPlayers, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (Date.now() > deadline) throw new Error('timeout waiting lobby');
    const m = await waitMsg(ws, 'race:lobby', timeout);
    if ((m.players || []).length >= minPlayers) return m;
  }
};

const onceOpen = (ws) =>
  new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

const a = new WebSocket(URL);
const b = new WebSocket(URL);
await Promise.all([onceOpen(a), onceOpen(b)]);

// create
a.send(JSON.stringify({ type: 'race:create', name: 'Алекс', lang: 'en' }));
const created = await waitMsg(a, 'race:created');
check('код комнаты — 6 символов A-Z0-9', /^[A-Z0-9]{6}$/.test(created.code));

// join
b.send(JSON.stringify({ type: 'race:join', code: created.code, name: 'Борис', lang: 'en' }));
const lobbyA = await waitLobby(a, 2);
const lobbyB = await waitLobby(b, 2);
check('в лобби двое (создатель)', lobbyA.players.length === 2);
check('в лобби двое (гость)', lobbyB.players.length === 2);
check('имена в лобби', lobbyA.players.some((p) => p.name === 'Алекс') && lobbyA.players.some((p) => p.name === 'Борис'));

// start → countdown 3..2..1 → started
b.send(JSON.stringify({ type: 'race:start' }));
await waitMsg(a, 'race:countdown');
const startedA = await waitMsg(a, 'race:started', 10000);
const startedB = await waitMsg(b, 'race:started', 10000);
check('50 слов в гонке', Array.isArray(startedA.words) && startedA.words.length === 50);
check('слова на английском', startedA.words.every((w) => /^[a-z]+$/.test(w)));
check('startTime передан', typeof startedA.startTime === 'number' && startedB.startTime === startedA.startTime);

// progress: оба шлют, сервер рассылает сводку обоим
a.send(JSON.stringify({ type: 'race:progress', chars: 12, wpm: 60, accuracy: 98 }));
b.send(JSON.stringify({ type: 'race:progress', chars: 7, wpm: 42, accuracy: 95 }));
const progA = await waitMsg(a, 'race:progress');
const progB = await waitMsg(b, 'race:progress');
check('broadcast прогресса обоим', progA.players.length === 2 && progB.players.length === 2);
check('прогресс Алекса в сводке', progA.players.some((p) => p.name === 'Алекс' && p.progress === 12));

// finish: оба завершают, приходит race:finished с сортировкой
a.send(JSON.stringify({ type: 'race:finish', wpm: 88, accuracy: 97.5, chars: { correct: 440, incorrect: 6, extra: 2 } }));
b.send(JSON.stringify({ type: 'race:finish', wpm: 66, accuracy: 95.1, chars: { correct: 330, incorrect: 8, extra: 0 } }));
const finA = await waitMsg(a, 'race:finished', 10000);
const finB = await waitMsg(b, 'race:finished', 10000);
check('результаты для обоих игроков', finA.results.length === 2 && finB.results.length === 2);
check('сортировка: Алекс (440) выше Бориса (330)', finA.results[0].name === 'Алекс' && finA.results[1].name === 'Борис');
check('wpm в результатах', finA.results[0].wpm === 88 && finA.results[1].wpm === 66);

// повторный finish игнорируется, гонка в состоянии finished
a.send(JSON.stringify({ type: 'race:finish', wpm: 99, accuracy: 100, chars: { correct: 999, incorrect: 0, extra: 0 } }));
const doubleBroadcast = await waitMsg(a, 'race:finished', 1300)
  .then(() => true)
  .catch(() => false);
check('повторный finish не рассылает race:finished', !doubleBroadcast);

// join в идущую гонку отклоняется
const c = new WebSocket(URL);
await onceOpen(c);
c.send(JSON.stringify({ type: 'race:join', code: created.code, name: 'Опоздал' }));
const errC = await waitMsg(c, 'race:error');
check('поздний join отклоняется', typeof errC.message === 'string' && errC.message.length > 0);
c.close();

a.close();
b.close();

console.log(failures ? `\nИТОГ: ${failures} проверок провалено` : '\nИТОГ: все проверки пройдены');
process.exit(failures ? 1 : 0);
