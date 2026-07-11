// server.js — ПАНЕЛЬ (деплоится на бесплатный хостинг, напр. Render)
// Сама НЕ запускает никакие процессы — только UI + реле команд к агенту,
// который подключается к ней СНАРУЖИ через wss://.../ws-agent
// Node.js 18+

const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

// ====================== НАСТРОЙКИ (через переменные окружения на хостинге) ======================
const ADMIN_PASSWORD = process.env.PANEL_PASSWORD || 'change-me';     // пароль для входа на сайт
const AGENT_TOKEN    = process.env.AGENT_TOKEN    || 'change-me-too'; // секрет между панелью и агентом
const PORT           = process.env.PORT || 3000;

// ====================== СОСТОЯНИЕ (в памяти, приходит от агента) ======================
let serverMeta = {};     // id -> { title, tab }
let serverState = {};    // id -> { running }
let serverBuffers = {};  // id -> [строки консоли]
let agentConnected = false;
let agentSocket = null;

function ensureMeta(id, title, tab) {
  serverMeta[id] = { title: title || id, tab: tab !== false };
  if (!serverState[id]) serverState[id] = { running: false };
  if (!serverBuffers[id]) serverBuffers[id] = [];
}

// ====================== АВТОРИЗАЦИЯ БРАУЗЕРА (по паролю сайта) ======================
const sessions = new Set();
function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'auth required' });
}

// ====================== HTTP / API ======================
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'wrong password' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.cookies.session);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/status', requireAuth, (req, res) => {
  const out = {};
  for (const id of Object.keys(serverMeta)) {
    out[id] = { title: serverMeta[id].title, tab: serverMeta[id].tab, running: serverState[id].running };
  }
  res.json({ servers: out, agentConnected });
});

app.get('/api/server/:id/history', requireAuth, (req, res) => {
  res.json({ lines: serverBuffers[req.params.id] || [] });
});

function sendToAgent(obj) {
  if (agentSocket && agentSocket.readyState === 1) {
    agentSocket.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

app.post('/api/server/:id/:action', requireAuth, (req, res) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'bad action' });
  if (!sendToAgent({ type: 'action', id, action })) return res.status(503).json({ error: 'agent offline' });
  res.json({ ok: true });
});

app.post('/api/all/:action', requireAuth, (req, res) => {
  const { action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'bad action' });
  if (!sendToAgent({ type: 'all', action })) return res.status(503).json({ error: 'agent offline' });
  res.json({ ok: true });
});

// ====================== WEBSOCKET ======================
const server = http.createServer(app);
const wssBrowser = new WebSocketServer({ noServer: true });
const wssAgent = new WebSocketServer({ noServer: true });

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws-agent') {
    // сюда подключается агент с твоего ПК — проверка токена внутри соединения (см. ниже)
    wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit('connection', ws, req));
  } else if (url.pathname === '/ws') {
    // сюда подключается браузер — проверка по сессионной cookie
    const token = readCookie(req, 'session');
    if (!token || !sessions.has(token)) { socket.destroy(); return; }
    wssBrowser.handleUpgrade(req, socket, head, (ws) => wssBrowser.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

const browserSockets = new Set();

wssBrowser.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('server');
  ws.watching = id;
  browserSockets.add(ws);
  ws.send(JSON.stringify({ type: 'history', lines: serverBuffers[id] || [] }));
  ws.send(JSON.stringify({ type: 'status', running: !!(serverState[id] && serverState[id].running) }));
  ws.send(JSON.stringify({ type: 'agent', connected: agentConnected }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input' && typeof msg.line === 'string') {
        sendToAgent({ type: 'input', id, line: msg.line });
      }
    } catch (_) {}
  });

  ws.on('close', () => browserSockets.delete(ws));
});

function broadcastToBrowsers(id, payload) {
  for (const ws of browserSockets) {
    if (ws.watching === id && ws.readyState === 1) ws.send(JSON.stringify(payload));
  }
}

function broadcastAgentState(connected) {
  for (const ws of browserSockets) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'agent', connected }));
  }
}

wssAgent.on('connection', (ws) => {
  let authed = false;
  const authTimeout = setTimeout(() => { if (!authed) ws.close(); }, 5000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (!authed) {
      if (msg.type === 'hello' && msg.token === AGENT_TOKEN) {
        authed = true;
        clearTimeout(authTimeout);
        // если уже был подключён другой агент — вежливо разрываем старый
        if (agentSocket && agentSocket !== ws) { try { agentSocket.close(); } catch (_) {} }
        agentSocket = ws;
        agentConnected = true;
        console.log('Агент подключился');
        if (msg.servers) {
          for (const [id, cfg] of Object.entries(msg.servers)) ensureMeta(id, cfg.title, cfg.tab);
        }
        broadcastAgentState(true);
      } else {
        ws.close();
      }
      return;
    }

    if (msg.type === 'status' && msg.id) {
      serverState[msg.id] = { running: !!msg.running };
      broadcastToBrowsers(msg.id, { type: 'status', running: !!msg.running });
    }
    if (msg.type === 'line' && msg.id) {
      const buf = serverBuffers[msg.id] || (serverBuffers[msg.id] = []);
      buf.push(msg.line);
      if (buf.length > 1000) buf.shift();
      broadcastToBrowsers(msg.id, { type: 'line', line: msg.line });
    }
  });

  ws.on('close', () => {
    if (ws === agentSocket) {
      agentConnected = false;
      agentSocket = null;
      console.log('Агент отключился');
      broadcastAgentState(false);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Панель запущена на порту ${PORT}`);
});
