'use strict';
// ── Server-side log interceptor ──────────────────────────────────────────────
// Must be required FIRST in index.js so it captures all subsequent module logs.
// Wraps console.log/warn/error, keeps a ring buffer, and emits 'line' events
// so index.js can forward them to connected WebSocket clients.

const { EventEmitter } = require('events');

const MAX_LINES = 150;
const emitter   = new EventEmitter();
const buffer    = [];

function capture(level, original) {
  return function (...args) {
    original.apply(console, args);
    const text = args
      .map(a => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    const line = { ts: Date.now(), level, text };
    buffer.push(line);
    if (buffer.length > MAX_LINES) buffer.shift();
    emitter.emit('line', line);
  };
}

// Patch before anything else runs
console.log   = capture('info',  console.log.bind(console));
console.warn  = capture('warn',  console.warn.bind(console));
console.error = capture('error', console.error.bind(console));

module.exports = {
  getBuffer: () => [...buffer],
  on: emitter.on.bind(emitter),
};
