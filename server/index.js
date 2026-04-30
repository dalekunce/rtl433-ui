'use strict';
const express          = require('express');
const http             = require('http');
const path             = require('path');
const { WebSocketServer } = require('ws');

const config     = require('./config');
const store      = require('./store');
const rtl433     = require('./rtl433');
const mqttClient = require('./mqtt');
const api        = require('./api');

// ── HTTP + WebSocket server ────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/api', api);

// ── WebSocket helpers ──────────────────────────────────────────────────────
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

wss.on('connection', ws => {
  // Send full current state to the new client immediately
  ws.send(JSON.stringify({
    type:     'init',
    devices:  store.getDevices(),
    mappings: store.getMappings(),
    status:   { rtl433: rtl433.getStatus(), mqtt: mqttClient.getStatus(), frequency: rtl433.getFrequency() },
  }));
});

// ── rtl_433 events ─────────────────────────────────────────────────────────
rtl433.on('data', data => {
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
});

rtl433.on('status', status => {
  broadcast({ type: 'status_update', rtl433: status, frequency: rtl433.getFrequency() });
});

rtl433.on('log', line => {
  // Forward rtl_433 informational messages to the dashboard
  broadcast({ type: 'rtl433_log', line });
});

// Purge stale devices every 60 s and push a full refresh to clients
setInterval(() => {
  store.purgeStale();
  broadcast({ type: 'devices_full', devices: store.getDevices() });
}, 60_000);

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  rtl433.start();
});

process.on('SIGINT', () => {
  console.log('\n[server] Shutting down…');
  rtl433.stop();
  process.exit(0);
});
