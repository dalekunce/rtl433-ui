'use strict';
// ── rtl_433 subprocess manager ────────────────────────────────────────────────
// Spawns the local rtl_433 binary, parses JSON output line-by-line, and emits
// the same 'data' events that mqtt.js emits so both feed the same pipeline.
// The process auto-restarts on crash with exponential backoff.

const { spawn }        = require('child_process');
const readline         = require('readline');
const fs               = require('fs');
const { EventEmitter } = require('events');

const CONFIG_FILE = process.env.RTL433_CONFIG || '/data/rtl433.conf';
const RTL433_BIN  = process.env.RTL433_BIN    || 'rtl_433';

const emitter = new EventEmitter();

let proc         = null;
let procStatus   = 'stopped';   // 'stopped' | 'starting' | 'running' | 'error'
let procError    = '';
let wantRunning  = false;
let restartTimer = null;
let restartDelay = 3000;        // ms, doubles on each failure up to 60 s
let currentFreq  = null;        // override frequency (null = use config file value)

// ── Status helpers ─────────────────────────────────────────────────────────
function setStatus(s, err = '') {
  procStatus = s;
  procError  = err;
  emitter.emit('status', { status: s, error: err });
}

function getStatus() {
  return { status: procStatus, error: procError };
}

// ISM bands to hop when running with no config file and no explicit freq set.
// Covers the four most common worldwide RTL-SDR frequencies.
const DEFAULT_FREQS = ['433.92M', '868M', '315M', '915M'];

// ── Build command-line args ────────────────────────────────────────────────
function buildArgs() {
  const args = [];
  const hasConfig = fs.existsSync(CONFIG_FILE);

  // Config file (user-uploaded, lives in persistent /data)
  if (hasConfig) {
    args.push('-c', CONFIG_FILE);
  }

  // Frequency: explicit override > config file > default multi-band hop
  if (currentFreq) {
    args.push('-f', currentFreq);
  } else if (!hasConfig) {
    // No config file — hop all four ISM bands for maximum device discovery
    for (const f of DEFAULT_FREQS) args.push('-f', f);
  }
  // (if config file exists, its own frequency/hop settings take effect)

  // Always output newline-delimited JSON to stdout
  args.push('-F', 'json');
  return args;
}

// ── Spawn ──────────────────────────────────────────────────────────────────
function _spawn() {
  if (proc) return;

  const args = buildArgs();
  console.log(`[rtl433] Spawning: ${RTL433_BIN} ${args.join(' ')}`);
  setStatus('starting');

  try {
    proc = spawn(RTL433_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`[rtl433] Failed to spawn: ${e.message}`);
    setStatus('error', e.message);
    proc = null;
    if (wantRunning) _scheduleRestart();
    return;
  }

  // Parse JSON lines from stdout
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', raw => {
    const line = raw.trim();
    if (!line) return;
    // Try to detect JSON object lines (rtl_433 emits one per received packet)
    if (!line.startsWith('{')) return;
    try {
      const data = JSON.parse(line);
      // First successful parse — we're definitely running
      if (procStatus !== 'running') {
        setStatus('running');
        restartDelay = 3000; // reset backoff
      }
      emitter.emit('data', data);
    } catch {
      /* non-JSON line, ignore */
    }
  });

  // Forward stderr to our logger (shows device detection, startup info)
  proc.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    if (text) {
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[rtl433] ${line.trim()}`);
      }
    }
  });

  proc.on('error', err => {
    console.error(`[rtl433] Process error: ${err.message}`);
    setStatus('error', err.message);
    proc = null;
    if (wantRunning) _scheduleRestart();
  });

  proc.on('exit', (code, signal) => {
    proc = null;
    if (!wantRunning) {
      setStatus('stopped');
      return;
    }
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    console.warn(`[rtl433] Process ended (${reason})`);
    setStatus('error', reason);
    _scheduleRestart();
  });
}

function _scheduleRestart() {
  if (restartTimer) return;
  console.log(`[rtl433] Will restart in ${restartDelay / 1000}s…`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (wantRunning) _spawn();
  }, restartDelay);
  restartDelay = Math.min(restartDelay * 2, 60_000);
}

// ── Public API ─────────────────────────────────────────────────────────────
function start() {
  wantRunning = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  _spawn();
}

function stop() {
  wantRunning = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (proc) {
    proc.kill('SIGTERM');
    proc = null;
  }
  setStatus('stopped');
}

function restart() {
  if (proc) {
    proc.kill('SIGTERM');
    proc = null;
  }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  restartDelay = 3000;
  if (wantRunning) {
    setTimeout(_spawn, 500);
  }
}

function setFrequency(freq) {
  currentFreq = freq || null;
  restart();
}

// ── Config file helpers ────────────────────────────────────────────────────
function readConfig() {
  try {
    return fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : '';
  } catch (e) {
    return '';
  }
}

function writeConfig(text) {
  fs.mkdirSync(require('path').dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, text, 'utf8');
}

// ── Auto-start on module load ──────────────────────────────────────────────
// Try immediately; if rtl_433 binary is missing or no dongle is found
// the process exits and we retry with backoff — visible in the log panel.
start();

function getFrequency() {
  return currentFreq; // null means auto/multi-band
}

module.exports = { start, stop, restart, setFrequency, getFrequency, readConfig, writeConfig, getStatus, on: emitter.on.bind(emitter) };
