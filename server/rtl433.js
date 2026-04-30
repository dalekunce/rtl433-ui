'use strict';
const { spawn }       = require('child_process');
const { EventEmitter } = require('events');
const config          = require('./config');

class RTL433 extends EventEmitter {
  constructor() {
    super();
    this.proc    = null;
    this.running = false;
    this._stopped = false; // set true on explicit stop() to prevent auto-restart
  }

  start() {
    if (this.running) return;
    this._activeArgs = config.rtl433Args;
    this._startWithArgs(this._activeArgs);
  }

  stop() {
    this._stopped = true;
    if (this.proc) {
      this._killGracefully(this.proc);
      this.proc    = null;
      this.running = false;
      this.emit('status', 'stopped');
    }
  }

  /**
   * Stop the current process and restart with a new frequency arg.
   * Merges the new -f value into the base args from config, replacing any
   * existing -f flag.
   *
   * @param {string} frequency  e.g. "433.92M", "315M", "868M", "915M"
   */
  restart(frequency) {
    this._stopped = true;
    if (this.proc) {
      this._killGracefully(this.proc);
      this.proc    = null;
      this.running = false;
    }

    // Build new args: strip any existing -f / --frequency flags then prepend new one
    const base    = config.rtl433Args.filter((a, i, arr) =>
      a !== '-f' && a !== '--frequency' && arr[i - 1] !== '-f' && arr[i - 1] !== '--frequency'
    );
    this._activeArgs = ['-f', frequency, ...base];

    console.log(`[rtl_433] Restarting on ${frequency}`);
    // Delay so the killed process fully releases the USB device before
    // the new one tries to claim it. Must be > the SIGTERM→SIGKILL window (1.5s).
    setTimeout(() => {
      this._stopped = false;
      this._startWithArgs(this._activeArgs);
    }, 2000);
  }

  /**
   * Send SIGTERM and wait up to 1.5 s for exit; escalate to SIGKILL if needed.
   * This gives libusb time to release the USB device before the next process claims it.
   */
  _killGracefully(proc) {
    if (!proc || proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    const guard = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, 1500);
    proc.once('exit', () => clearTimeout(guard));
  }

  _startWithArgs(args) {
    if (this.running) return;
    this._stopped = false;

    console.log(`[rtl_433] ${config.rtl433Bin} ${args.join(' ')}`);

    try {
      this.proc = spawn(config.rtl433Bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.error(`[rtl_433] Failed to spawn: ${err.message}`);
      this.emit('status', 'error');
      if (!this._stopped) setTimeout(() => this._startWithArgs(args), 10_000);
      return;
    }

    this.running = true;
    this.emit('status', 'running');

    let buf = '';
    this.proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try { this.emit('data', JSON.parse(trimmed)); } catch { /* skip */ }
      }
    });

    this.proc.stderr.on('data', chunk => {
      this.emit('log', chunk.toString().trim());
    });

    this.proc.on('error', err => {
      console.error(`[rtl_433] Process error: ${err.message}`);
    });

    this.proc.on('exit', (code, signal) => {
      this.running = false;
      this.emit('status', 'stopped');
      if (!this._stopped) {
        console.warn(`[rtl_433] Exited (code=${code}, signal=${signal}). Restarting in 5 s…`);
        setTimeout(() => this._startWithArgs(args), 5_000);
      }
    });
  }

  getStatus() {
    return this.running ? 'running' : 'stopped';
  }

  getFrequency() {
    if (!this._activeArgs) return null;
    const i = this._activeArgs.indexOf('-f');
    return i !== -1 ? this._activeArgs[i + 1] : null;
  }
}

module.exports = new RTL433();
