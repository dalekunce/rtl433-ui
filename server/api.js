'use strict';
const express    = require('express');
const store      = require('./store');
const rtl433     = require('./rtl433');
const mqttClient = require('./mqtt');
const config     = require('./config');

const router = express.Router();
router.use(express.json());

// GET /api/status
router.get('/status', (_req, res) => {
  res.json({
    rtl433:    rtl433.getStatus(),
    mqtt:      mqttClient.getStatus(),
    frequency: rtl433.getFrequency(),
  });
});

// GET /api/devices
router.get('/devices', (_req, res) => {
  res.json(store.getDevices());
});

// GET /api/mappings
router.get('/mappings', (_req, res) => {
  res.json(store.getMappings());
});

// POST /api/mappings  { model, id, field, topic }
router.post('/mappings', (req, res) => {
  const { model, id, field, topic } = req.body ?? {};
  if (!model || !field || !topic) {
    return res.status(400).json({ error: '`model`, `field`, and `topic` are required' });
  }
  // Sanitise topic — must not contain wildcards
  if (/[#+]/.test(topic)) {
    return res.status(400).json({ error: 'MQTT topic must not contain wildcard characters (# or +)' });
  }
  store.addMapping(model, id, field, topic);
  res.json({ ok: true });
});

// DELETE /api/mappings  { model, id, field }
router.delete('/mappings', (req, res) => {
  const { model, id, field } = req.body ?? {};
  if (!model || !field) {
    return res.status(400).json({ error: '`model` and `field` are required' });
  }
  store.removeMapping(model, id, field);
  res.json({ ok: true });
});

// DELETE /api/devices  { model, id }
router.delete('/devices', (req, res) => {
  const { model, id } = req.body ?? {};
  if (!model) return res.status(400).json({ error: '`model` is required' });
  const removed = store.forgetDevice(model, id);
  res.json({ ok: true, removed });
});

// POST /api/frequency  { frequency: "433.92M" }
// Restarts rtl_433 on the requested frequency.
const ALLOWED_FREQS = new Set(['433.92M', '315M', '868M', '915M']);

router.post('/frequency', (req, res) => {
  const { frequency } = req.body ?? {};
  if (!frequency || !ALLOWED_FREQS.has(frequency)) {
    return res.status(400).json({
      error: `frequency must be one of: ${[...ALLOWED_FREQS].join(', ')}`,
    });
  }
  rtl433.restart(frequency);
  res.json({ ok: true, frequency });
});

// POST /api/publish  { topic, value }
// Immediately publishes a test message to the given MQTT topic.
router.post('/publish', (req, res) => {
  const { topic, value, retain } = req.body ?? {};
  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: '`topic` is required' });
  }
  if (/[#+]/.test(topic)) {
    return res.status(400).json({ error: 'MQTT topic must not contain wildcard characters (# or +)' });
  }
  mqttClient.publish(topic, value ?? '', { retain: retain === true });
  res.json({ ok: true });
});

// GET /api/config
// Returns current runtime config (never returns password value).
router.get('/config', (_req, res) => {
  res.json({
    mqttUrl:      config.mqttUrl,
    mqttUsername: config.mqttUsername,
    mqttHasPassword: !!config.mqttPassword,
  });
});

// POST /api/config  { mqttUrl, mqttUsername, mqttPassword }
// Saves settings and reconnects MQTT with new credentials.
router.post('/config', (req, res) => {
  const { mqttUrl, mqttUsername, mqttPassword } = req.body ?? {};

  if (mqttUrl !== undefined) {
    if (typeof mqttUrl !== 'string' || !mqttUrl.startsWith('mqtt')) {
      return res.status(400).json({ error: '`mqttUrl` must start with mqtt:// or mqtts://' });
    }
    config.mqttUrl = mqttUrl;
  }
  if (mqttUsername !== undefined) config.mqttUsername = String(mqttUsername);
  if (mqttPassword !== undefined) config.mqttPassword = String(mqttPassword);

  const patch = {};
  if (mqttUrl      !== undefined) patch.mqttUrl      = config.mqttUrl;
  if (mqttUsername !== undefined) patch.mqttUsername = config.mqttUsername;
  if (mqttPassword !== undefined) patch.mqttPassword = config.mqttPassword;
  config.saveSettings(patch);

  mqttClient.reconnect();
  res.json({ ok: true });
});

module.exports = router;
