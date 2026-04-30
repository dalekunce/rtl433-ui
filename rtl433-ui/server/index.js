'use strict';
// logger must be first — it patches console.* before any other module loads
const logger           = require('./logger');

const express          = require('express');
const http             = require('http');
const path             = require('path');
const { WebSocketServer } = require('ws');

const config     = require('./config');
const store      = require('./store');
const mqttClient = require('./mqtt');
const rtl433proc = require('./rtl433proc');
const api        = require('./api');

// ── HTTP + WebSocket server ────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/api', api);

// ── WebSocket helpers ──────────────────────────────────────────────────────
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

wss.on('connection', (ws, req) => {
  console.log(`[ws] client connected from ${req.socket.remoteAddress}`);
  ws.send(JSON.stringify({
    type:     'init',
    devices:  store.getDevices(),
    mappings: store.getMappings(),
    status:   {
      mqtt:       mqttClient.getStatus(),
      rtl433:     store.getRtl433Status(),
      rtl433proc: rtl433proc.getStatus().status,
    },
  }));
  // Send buffered log lines so the panel is populated immediately on connect
  ws.send(JSON.stringify({ type: 'logs_init', lines: logger.getBuffer() }));
});

// ── Device data from MQTT (published by external rtl_433 add-on) ──────────
mqttClient.on('data', handleData);

// ── Device data from local rtl_433 subprocess ─────────────────────────────
rtl433proc.on('data', handleData);

function handleData(data) {
  store.recordDataReceived();
  const dev = store.updateDevice(data);
  if (!dev) return;

  // Publish every changed field that has an MQTT mapping
  const fieldMappings = store.getMappingsForDevice(dev.model, dev.id);
  for (const [field, topic] of Object.entries(fieldMappings)) {
    if (field in dev.fields) {
      mqttClient.publish(topic, dev.fields[field].value);
    }
  }

  broadcast({ type: 'device_update', device: dev });
  broadcast({ type: 'raw', data });
}

// ── MQTT connection status → broadcast ────────────────────────────────────
mqttClient.on('status', status => {
  broadcast({ type: 'status_update', mqtt: status });
});

// ── rtl_433 subprocess process status → broadcast ─────────────────────────
rtl433proc.on('status', ({ status }) => {
  broadcast({ type: 'status_update', rtl433proc: status });
});

// ── Server log lines → broadcast ───────────────────────────────────────────
logger.on('line', line => {
  broadcast({ type: 'log_line', line });
});

// ── rtl_433 data-flow status → broadcast every 5 s ────────────────────────
setInterval(() => {
  broadcast({ type: 'status_update', rtl433: store.getRtl433Status() });
}, 5_000);

// Purge stale devices every 60 s and push a full refresh to clients
setInterval(() => {
  store.purgeStale();
  broadcast({ type: 'devices_full', devices: store.getDevices() });
}, 60_000);

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(config.port, '0.0.0.0', () => {
  console.log(`[server] http://0.0.0.0:${config.port}`);
});

process.on('SIGINT', () => {
  console.log('\n[server] Shutting down…');
  process.exit(0);
});
