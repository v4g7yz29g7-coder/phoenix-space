'use strict';

/**
 * api/websocket_api.js
 * ---------------------------------------------------------------------------
 * Dependency-free WebSocket (RFC 6455) server built on Node's `http` module.
 *
 * Public API (exactly what callers need):
 *
 *   const ws = require('./api/websocket_api');
 *
 *   const srv = await ws.start(8081);     // boot, resolves with the server
 *   srv.emit('tick', { price: 42 });      // broadcast -> returns client count
 *   srv.emit('dm', data, { to: clientId }); // targeted -> returns client count
 *   srv.on('message', (msg, client) => {}); // inbound client messages
 *   srv.stats();                          // { clients, running, ... }
 *   await srv.stop();                     // graceful shutdown
 *
 * Module-level convenience helpers `start`, `emit` and `stop` operate on the
 * most recently started server, mirroring the advertised `start(port)` /
 * `emit(event)` surface.
 *
 * Events delivered to clients are JSON envelopes: { event, data }.
 * On connect the server automatically sends: { event: 'welcome', data: { id } }.
 */

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_PORT = 8081;
const MAX_PAYLOAD = 64 * 1024 * 1024; // 64 MiB safety cap

const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

const STATE = Object.freeze({
  OPEN: 'open',
  CLOSING: 'closing',
  CLOSED: 'closed',
});

/* ------------------------------------------------------------------------- */
/* Handshake helpers                                                         */
/* ------------------------------------------------------------------------- */

function computeAccept(key) {
  return crypto
    .createHash('sha1')
    .update(String(key) + WS_GUID)
    .digest('base64');
}

function isValidUpgrade(req) {
  const connection = String(req.headers.connection || '').toLowerCase();
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const version = String(req.headers['sec-websocket-version'] || '');
  return (
    req.method === 'GET' &&
    connection.split(',').map((s) => s.trim()).includes('upgrade') &&
    upgrade === 'websocket' &&
    version === '13' &&
    typeof req.headers['sec-websocket-key'] === 'string'
  );
}

/* ------------------------------------------------------------------------- */
/* Frame encoding / decoding                                                 */
/* ------------------------------------------------------------------------- */

function encodeFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }

  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

function unmask(payload, mask) {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i += 1) out[i] ^= mask[i % 4];
  return out;
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];

    const fin = (first & 0x80) === 0x80;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let pos = offset + 2;

    if (length === 126) {
      if (pos + 2 > buffer.length) break;
      length = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (length === 127) {
      if (pos + 8 > buffer.length) break;
      const high = buffer.readUInt32BE(pos);
      const low = buffer.readUInt32BE(pos + 4);
      length = high * 0x100000000 + low;
      pos += 8;
    }

    if (length > MAX_PAYLOAD) throw new Error('Frame exceeds maximum payload size');

    let mask = null;
    if (masked) {
      if (pos + 4 > buffer.length) break;
      mask = buffer.slice(pos, pos + 4);
      pos += 4;
    }

    if (pos + length > buffer.length) break;

    let payload = buffer.slice(pos, pos + length);
    if (mask) payload = unmask(payload, mask);

    frames.push({ fin, opcode, payload });
    offset = pos + length;
  }

  return { frames, rest: buffer.slice(offset) };
}

/* ------------------------------------------------------------------------- */
/* Connection wrapper                                                        */
/* ------------------------------------------------------------------------- */

class WebSocketConnection extends EventEmitter {
  constructor(socket, server) {
    super();
    this.socket = socket;
    this.server = server;
    this.state = STATE.OPEN;
    this.id = crypto.randomBytes(8).toString('hex');
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.alive = true;
    this.remote = socket.remoteAddress || null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => this._onError(err));
  }

  get open() {
    return this.state === STATE.OPEN;
  }

  _onData(chunk) {
    if (this.state === STATE.CLOSED) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);

    let decoded;
    try {
      decoded = decodeFrames(this.buffer);
    } catch (err) {
      return this.close(1009, err.message);
    }

    this.buffer = decoded.rest;
    for (const frame of decoded.frames) this._onFrame(frame);
  }

  _onFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.CONTINUATION:
        this.fragments.push(frame.payload);
        if (frame.fin) this._flushFragments();
        break;
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (frame.fin) {
          this._deliver(frame.opcode, frame.payload);
        } else {
          this.fragmentOpcode = frame.opcode;
          this.fragments = [frame.payload];
        }
        break;
      case OPCODE.PING:
        this._raw(encodeFrame(frame.payload, OPCODE.PONG));
        this.emit('ping', frame.payload);
        break;
      case OPCODE.PONG:
        this.alive = true;
        this.emit('pong', frame.payload);
        break;
      case OPCODE.CLOSE:
        this.close(1000, '');
        break;
      default:
        this.close(1002, 'Unknown opcode');
    }
  }

  _flushFragments() {
    const payload = Buffer.concat(this.fragments);
    const opcode = this.fragmentOpcode === null ? OPCODE.TEXT : this.fragmentOpcode;
    this.fragments = [];
    this.fragmentOpcode = null;
    this._deliver(opcode, payload);
  }

  _deliver(opcode, payload) {
    if (opcode === OPCODE.TEXT) this.emit('message', payload.toString('utf8'));
    else this.emit('message', payload);
  }

  _raw(buf) {
    if (this.state === STATE.CLOSED) return false;
    if (!this.socket.writable) return false;
    this.socket.write(buf);
    return true;
  }

  /** Send a raw text/binary frame. */
  send(data) {
    if (this.state !== STATE.OPEN) return false;
    const opcode = Buffer.isBuffer(data) ? OPCODE.BINARY : OPCODE.TEXT;
    return this._raw(encodeFrame(data, opcode));
  }

  /** Send a structured { event, data } envelope. */
  sendEvent(event, data) {
    return this.send(JSON.stringify({ event, data: data === undefined ? null : data }));
  }

  ping(data) {
    this.alive = false;
    this._raw(encodeFrame(data || '', OPCODE.PING));
  }

  close(code, reason) {
    if (this.state === STATE.CLOSED) return;
    this.state = STATE.CLOSING;
    const codeBuf = Buffer.alloc(2);
    codeBuf.writeUInt16BE(code || 1000, 0);
    const reasonBuf = Buffer.from(reason || '', 'utf8');
    this._raw(encodeFrame(Buffer.concat([codeBuf, reasonBuf]), OPCODE.CLOSE));
    this.state = STATE.CLOSED;
    try {
      this.socket.end();
    } catch (err) {
      /* ignore */
    }
  }

  _onClose() {
    if (this.state === STATE.CLOSED) {
      this.server._forget(this);
      return;
    }
    this.state = STATE.CLOSED;
    this.emit('close');
    this.server._forget(this);
  }

  _onError(err) {
    this.emit('error', err);
  }
}

/* ------------------------------------------------------------------------- */
/* Server                                                                    */
/* ------------------------------------------------------------------------- */

class WebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options || {};
    this.clients = new Set();
    this.running = false;
    this.port = null;
    this.httpServer = null;
    this.heartbeat = null;
    this.stats = this.stats.bind(this);
    this._counters = { connections: 0, messagesIn: 0, messagesOut: 0 };
  }

  /**
   * Boot the server. Resolves with this instance (after `listening`).
   * Passing port 0 lets the OS pick a free port (available via `this.port`).
   */
  start(port, options) {
    if (this.running) return Promise.resolve(this);
    const opts = Object.assign({}, this.options, options || {});
    const httpServer = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain', Upgrade: 'websocket' });
      res.end('Upgrade Required\n');
    });

    httpServer.on('upgrade', (req, socket) => {
      if (!isValidUpgrade(req)) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      this.handleUpgrade(req, socket);
    });

    httpServer.on('error', (err) => this._notify('error', err));

    this.httpServer = httpServer;
    const listenPort = port === undefined || port === null ? DEFAULT_PORT : port;

    return new Promise((resolve, reject) => {
      const onError = (err) => {
        httpServer.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.removeListener('error', onError);
        const addr = httpServer.address();
        this.port = addr && typeof addr === 'object' ? addr.port : listenPort;
        this.running = true;
        if (opts.heartbeat !== false) this.startHeartbeat(opts.heartbeatInterval);
        resolve(this);
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(listenPort);
    });
  }

  handleUpgrade(req, socket) {
    const accept = computeAccept(req.headers['sec-websocket-key']);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const conn = new WebSocketConnection(socket, this);
    this.clients.add(conn);
    this._counters.connections += 1;

    conn.on('message', (raw) => {
      this._counters.messagesIn += 1;
      let payload = raw;
      if (typeof raw === 'string') {
        try {
          payload = JSON.parse(raw);
        } catch (err) {
          /* keep the raw string */
        }
      }
      this._notify('message', payload, conn);
    });

    conn.on('close', () => this._notify('disconnect', conn));
    conn.on('error', () => {});

    // Greet the freshly connected client with its id.
    conn.sendEvent('welcome', { id: conn.id, time: Date.now() });

    this._notify('connection', conn);
    return conn;
  }

  _forget(conn) {
    this.clients.delete(conn);
  }

  /** Broadcast (or target) an event. Returns the number of clients reached. */
  broadcast(event, data, opts) {
    if (typeof event !== 'string' || event.length === 0) {
      throw new TypeError('emit(event, data): event must be a non-empty string');
    }
    let sent = 0;
    if (opts && opts.to) {
      for (const client of this.clients) {
        if (client.id === opts.to && client.sendEvent(event, data)) sent += 1;
      }
    } else {
      for (const client of this.clients) {
        if (client.state === STATE.OPEN && client.sendEvent(event, data)) sent += 1;
      }
    }
    this._counters.messagesOut += sent;
    return sent;
  }

  /** Public overload used by callers: srv.emit(event, data[, opts]). */
  emit(event, data, opts) {
    return this.broadcast(event, data, opts);
  }

  /** Emit onto the local EventEmitter without clobbering the broadcast API. */
  _notify(type) {
    return EventEmitter.prototype.emit.apply(this, arguments);
  }

  startHeartbeat(interval) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const ms = typeof interval === 'number' && interval > 0 ? interval : 30000;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (client.state !== STATE.OPEN || !client.alive) {
          client.close(1001, 'Heartbeat timeout');
          continue;
        }
        client.ping();
      }
    }, ms);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  stats() {
    return {
      clients: this.clients.size,
      connections: this._counters.connections,
      messagesIn: this._counters.messagesIn,
      messagesOut: this._counters.messagesOut,
      running: this.running,
      port: this.port,
    };
  }

  /** Graceful shutdown. Resolves once the listener is closed. */
  stop() {
    this.running = false;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const client of this.clients) client.close(1001, 'Server shutting down');
    this.clients.clear();

    return new Promise((resolve) => {
      if (!this.httpServer) return resolve();
      const srv = this.httpServer;
      this.httpServer = null;
      srv.close(() => resolve());
      // Safety: resolve even if close() never fires (no listeners).
      setTimeout(resolve, 50).unref();
    });
  }
}

/* ------------------------------------------------------------------------- */
/* Module-level API                                                          */
/* ------------------------------------------------------------------------- */

let current = null;

/** start(port[, options]) -> Promise<WebSocketServer> */
function start(port, options) {
  const server = new WebSocketServer(options);
  return server.start(port, options).then((srv) => {
    current = srv;
    return srv;
  });
}

/** emit(event[, payload][, opts]) -> number (clients reached). */
function emit(event, payload, opts) {
  if (!current) return 0;
  return current.broadcast(event, payload, opts);
}

/** stop([callback]) -> Promise<void> for the most recent server. */
function stop(callback) {
  if (!current) {
    if (typeof callback === 'function') callback();
    return Promise.resolve();
  }
  const p = current.stop();
  if (typeof callback === 'function') p.then(() => callback());
  return p;
}

module.exports = {
  start,
  emit,
  stop,
  WebSocketServer,
  WebSocketConnection,
  OPCODE,
  STATE,
  get server() {
    return current;
  },
  _internal: { encodeFrame, decodeFrames, computeAccept, isValidUpgrade },
};
