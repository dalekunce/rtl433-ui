'use strict';
const mqtt   = require('mqtt');
const config = require('./config');

let client    = null;
let connected = false;

function connect() {
  console.log(`[mqtt] Connecting to ${config.mqttUrl}`);

  const opts = {
    clientId:        `rtl433-ui-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 5_000,
    connectTimeout:  10_000,
  };
  if (config.mqttUsername) opts.username = config.mqttUsername;
  if (config.mqttPassword) opts.password = config.mqttPassword;

  client = mqtt.connect(config.mqttUrl, opts);

  client.on('connect', () => {
    connected = true;
    console.log('[mqtt] Connected');
  });

  client.on('reconnect', () => {
    console.log('[mqtt] Reconnecting…');
  });

  client.on('error', err => {
    console.error(`[mqtt] Error: ${err.message}`);
  });

  client.on('close', () => {
    connected = false;
  });
}

function reconnect() {
  console.log('[mqtt] Reconnecting with new settings…');
  if (client) {
    client.end(true);  // force-close without waiting for in-flight messages
    client = null;
  }
  connected = false;
  connect();
}

function publish(topic, value, opts = {}) {
  if (!connected || !client || !topic) return;
  client.publish(topic, String(value), { retain: opts.retain === true, qos: 0 });
}

function getStatus() {
  return connected ? 'connected' : 'disconnected';
}

connect();

module.exports = { publish, getStatus, reconnect };

