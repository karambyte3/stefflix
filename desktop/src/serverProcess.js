// Runs the media server (server/src/index.js) in an Electron utility process:
// a separate Node.js process, so a crash in the server doesn't take the tray app down with it.
//
// Emits:
//   'state' { status, port, addresses }   status: starting | running | stopped | port-in-use | crashed
//   'log'   [line, ...]                   new output lines of the server
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { utilityProcess } from 'electron';

// Must match EXIT_PORT_IN_USE in server/src/index.js.
const EXIT_PORT_IN_USE = 3;

const MAX_LOG_LINES = 500; // kept in memory for the window
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;

// A crashing server is restarted, but not forever: 3 crashes within a minute means it's broken.
const RESTART_DELAY_MS = 2000;
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60 * 1000;

export class ServerProcess extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.entry    path to server/src/index.js
   * @param {() => object} options.getEnv  environment variables with the server settings,
   *                                        read on every (re)start
   * @param {string} options.logFile  where the server output is appended
   */
  constructor({ entry, getEnv, logFile }) {
    super();
    this.entry = entry;
    this.getEnv = getEnv;
    this.logFile = logFile;
    this.child = null;
    this.stopping = false;
    this.crashes = [];
    this.restartTimer = null;
    this.logLines = [];
    this.state = { status: 'stopped', port: null, addresses: [] };

    rotateLogFile(logFile);
  }

  start() {
    if (this.child) return;
    clearTimeout(this.restartTimer);
    this.setState({ status: 'starting', port: null, addresses: [] });
    this.appendLog([`--- ${new Date().toLocaleString('bg-BG')} - starting the server ---`]);

    const child = utilityProcess.fork(this.entry, [], {
      serviceName: 'Stefflix server',
      // Same working folder as `npm run server`, so relative paths in server/.env mean the same.
      cwd: path.resolve(path.dirname(this.entry), '..'),
      env: { ...process.env, ...this.getEnv() },
      stdio: 'pipe',
    });
    this.child = child;

    pipeLines(child.stdout, (lines) => this.appendLog(lines));
    pipeLines(child.stderr, (lines) => this.appendLog(lines));

    child.on('message', (message) => {
      if (message?.type === 'listening') {
        this.setState({ status: 'running', port: message.port, addresses: message.addresses || [] });
      }
    });

    child.on('exit', (code) => this.onExit(child, code));
  }

  /** Stops the server; resolves once the process has exited. */
  stop() {
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) {
      this.setState({ status: 'stopped', port: null, addresses: [] });
      return Promise.resolve();
    }
    this.stopping = true;
    return new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
  }

  async restart() {
    this.crashes = [];
    await this.stop();
    this.start();
  }

  getLogs() {
    return this.logLines;
  }

  onExit(child, code) {
    if (this.child !== child) return;
    this.child = null;

    if (this.stopping) {
      this.stopping = false;
      this.appendLog(['--- server stopped ---']);
      this.setState({ status: 'stopped', port: null, addresses: [] });
      return;
    }

    if (code === EXIT_PORT_IN_USE) {
      this.setState({ status: 'port-in-use', port: null, addresses: [] });
      return;
    }

    const now = Date.now();
    this.crashes = this.crashes.filter((time) => now - time < CRASH_WINDOW_MS);
    this.crashes.push(now);
    if (this.crashes.length >= MAX_CRASHES) {
      this.appendLog([`--- the server exited with code ${code} again - giving up ---`]);
      this.setState({ status: 'crashed', port: null, addresses: [] });
      return;
    }

    this.appendLog([`--- the server exited with code ${code} - restarting ---`]);
    this.setState({ status: 'starting', port: null, addresses: [] });
    this.restartTimer = setTimeout(() => this.start(), RESTART_DELAY_MS);
  }

  setState(state) {
    this.state = state;
    this.emit('state', state);
  }

  appendLog(lines) {
    if (!lines.length) return;
    this.logLines.push(...lines);
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
    try {
      fs.appendFileSync(this.logFile, lines.join('\n') + '\n');
    } catch {
      // The log file is a convenience - never let it stop the server.
    }
    this.emit('log', lines);
  }
}

/** Calls `onLines` with complete lines from a stream (a chunk can end in the middle of a line). */
function pipeLines(stream, onLines) {
  if (!stream) return;
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop();
    if (lines.length) onLines(lines);
  });
  stream.on('end', () => {
    if (rest) onLines([rest]);
    rest = '';
  });
}

/** Keeps the log file small: once it's over the limit it becomes server.old.log. */
function rotateLogFile(logFile) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.statSync(logFile).size > MAX_LOG_FILE_BYTES) {
      fs.renameSync(logFile, logFile.replace(/\.log$/, '.old.log'));
    }
  } catch {
    // No log file yet.
  }
}
