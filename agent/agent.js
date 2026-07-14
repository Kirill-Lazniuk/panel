// agent.js — АГЕНТ (запускать ЛОКАЛЬНО, на той же машине, где лежат папки серверов)
// Сам инициирует соединение наружу к панели на хостинге, поэтому НЕ требует
// проброса портов или белого IP. Node.js 18+

// dotenv нужен, чтобы агент мог прочитать .env файл с локального ПК
// (сам агент не деплоится на хостинг, поэтому пакет тут можно просто установить,
// но на всякий случай тоже оборачиваем в try/catch)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv не установлен — тогда переменные нужно будет задавать вручную перед запуском
}

const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// ====================== НАСТРОЙКИ ======================
// PANEL_WS_URL — адрес твоей панели на хостинге, протокол wss:// (не https://)
// AGENT_TOKEN  — должен СОВПАДАТЬ с AGENT_TOKEN, который задан в переменных окружения панели
const PANEL_WS_URL = process.env.PANEL_WS_URL || 'wss://panel-koiq.onrender.com//ws-agent';
const AGENT_TOKEN  = process.env.AGENT_TOKEN;

if (!AGENT_TOKEN) {
  console.error('❌ Не задана переменная окружения AGENT_TOKEN (проверь .env файл рядом с agent.js)');
  process.exit(1);
}

// Порядок в этом объекте = порядок запуска в "Запустить всё"
const SERVERS = {
  playit: {
    title: 'Playit.gg',
    cwd: 'C:\\Program Files\\playit_gg\\bin',
    cmd: 'Playit.exe',
    args: [],
    stopCommand: null,
    tab: false
  },
  velocity: {
    title: 'Velocity',
    cwd: '../Velocity-Proxy',
    cmd: 'start.bat',
    args: [],
    stopCommand: 'end',
    tab: false
  },
  lobby: {
    title: 'Лобби',
    cwd: '../Lobby-server',
    cmd: 'run.bat',
    args: [],
    stopCommand: 'stop',
    tab: true
  },
  aoc: {
    title: 'AoC',
    cwd: '../AoC-server',
    cmd: 'run.bat',
    args: [],
    stopCommand: 'stop',
    tab: true
  },
  test: {
    title: 'Тест',
    cwd: '../Test-server',
    cmd: 'run.bat',
    args: [],
    stopCommand: 'stop',
    tab: true
  }
};

const START_DELAY_MS = { playit: 3000, velocity: 10000, lobby: 5000, aoc: 5000, test: 0 };

// ====================== ПРОЦЕСС-МЕНЕДЖЕР ======================
const procs = {};
function ensureState(id) {
  if (!procs[id]) procs[id] = { child: null };
  return procs[id];
}

let ws = null;
let wsReady = false;

function send(obj) {
  if (ws && wsReady) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function pushLine(id, line) {
  console.log(`[${id}] ${line}`);
  send({ type: 'line', id, line });
}

function broadcastStatus(id) {
  send({ type: 'status', id, running: !!ensureState(id).child });
}

function startServer(id) {
  const cfg = SERVERS[id];
  if (!cfg) { console.log('неизвестный id сервера:', id); return; }
  const st = ensureState(id);
  if (st.child) { pushLine(id, '[panel] уже запущен'); return; }

  const resolvedCwd = path.resolve(cfg.cwd);
  pushLine(id, `[panel] запуск: ${cfg.cmd} (в ${resolvedCwd})`);

  if (!fs.existsSync(resolvedCwd)) {
    pushLine(id, `[panel] ошибка запуска: папка не найдена: ${resolvedCwd}`);
    return;
  }
  if (!fs.existsSync(path.join(resolvedCwd, cfg.cmd))) {
    pushLine(id, `[panel] ошибка запуска: файл не найден: ${path.join(resolvedCwd, cfg.cmd)}`);
    return;
  }

  const child = spawn(cfg.cmd, cfg.args, {
    cwd: resolvedCwd,
    shell: true,
    windowsHide: true
  });
  st.child = child;
  broadcastStatus(id);

  child.stdout.on('data', (d) => d.toString('utf8').split(/\r?\n/).forEach(l => l && pushLine(id, l)));
  child.stderr.on('data', (d) => d.toString('utf8').split(/\r?\n/).forEach(l => l && pushLine(id, '[stderr] ' + l)));

  child.on('exit', (code) => {
    pushLine(id, `[panel] процесс завершён (код ${code})`);
    st.child = null;
    broadcastStatus(id);
  });

  child.on('error', (err) => {
    pushLine(id, `[panel] ошибка запуска: ${err.message}`);
    st.child = null;
    broadcastStatus(id);
  });
}

function killTree(id, pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${pid} /T /F`, (err) => {
        if (err) pushLine(id, `[panel] taskkill: ${err.message}`);
        resolve();
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
      resolve();
    }
  });
}

function stopServer(id) {
  const cfg = SERVERS[id];
  const st = ensureState(id);
  if (!st.child) { pushLine(id, '[panel] уже остановлен'); return Promise.resolve(); }

  return new Promise((resolve) => {
    const child = st.child;
    const pid = child.pid;
    const timeout = setTimeout(() => {
      pushLine(id, '[panel] не ответил на команду остановки, kill дерева процессов');
      killTree(id, pid);
    }, 20000);

    child.once('exit', () => { clearTimeout(timeout); resolve(); });

    if (cfg.stopCommand && child.stdin.writable) {
      pushLine(id, `[panel] отправляю "${cfg.stopCommand}" в консоль`);
      child.stdin.write(cfg.stopCommand + '\n');
    } else {
      pushLine(id, '[panel] мягкой остановки нет — kill дерева процессов');
      killTree(id, pid);
    }
  });
}

async function restartServer(id) {
  await stopServer(id);
  await new Promise(r => setTimeout(r, 1500));
  startServer(id);
}

async function startAll() {
  for (const id of Object.keys(SERVERS)) {
    startServer(id);
    await new Promise(r => setTimeout(r, START_DELAY_MS[id] || 0));
  }
}

async function stopAll() {
  const ids = Object.keys(SERVERS).reverse();
  for (const id of ids) await stopServer(id);
}

function sendInput(id, line) {
  const st = ensureState(id);
  if (st.child && st.child.stdin.writable) {
    st.child.stdin.write(line + '\n');
    pushLine(id, '> ' + line);
  }
}

// ====================== ПОДКЛЮЧЕНИЕ К ПАНЕЛИ ======================
function connect() {
  console.log('Подключаюсь к панели:', PANEL_WS_URL);
  ws = new WebSocket(PANEL_WS_URL);

  ws.on('open', () => {
    wsReady = true;
    console.log('Соединение установлено, авторизуюсь...');
    const meta = {};
    for (const [id, cfg] of Object.entries(SERVERS)) meta[id] = { title: cfg.title, tab: cfg.tab };
    send({ type: 'hello', token: AGENT_TOKEN, servers: meta });
    for (const id of Object.keys(SERVERS)) broadcastStatus(id);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'action' && msg.id) {
      if (msg.action === 'start') startServer(msg.id);
      if (msg.action === 'stop') stopServer(msg.id);
      if (msg.action === 'restart') restartServer(msg.id);
    }
    if (msg.type === 'all') {
      if (msg.action === 'start') startAll();
      if (msg.action === 'stop') stopAll();
      if (msg.action === 'restart') stopAll().then(startAll);
    }
    if (msg.type === 'input' && msg.id) sendInput(msg.id, msg.line);
  });

  ws.on('close', () => {
    wsReady = false;
    console.log('Отключено от панели, переподключение через 5с...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (e) => {
    console.log('Ошибка соединения:', e.message);
  });
}

connect();

process.on('SIGINT', async () => {
  console.log('Останавливаю все сервера перед выходом...');
  await stopAll();
  process.exit(0);
});
