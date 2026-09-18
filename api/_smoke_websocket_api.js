'use strict';

/**
 * api/_smoke_websocket_api.js
 * ---------------------------------------------------------------------------
 * End-to-end smoke test for api/websocket_api.js.
 *
 * Boots the server with start(port), connects a raw RFC6455 client over a
 * plain TCP socket, performs the handshake, then verifies that emit(event)
 * actually reaches the connected client.
 *
 * Run:  node api/_smoke_websocket_api.js
 */

const net = require('net');
const crypto = require('crypto');
const ws = require('./websocket_api');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PORT = 0; // 0 => let the OS pick a free port

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeMaskedFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
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
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([header, key, masked]);
}

function decodeFrames(buffer) {
  const frames = [];
  let buf = buffer;
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = buf.readUInt32BE(6);
      offset = 10;
    }
    if (masked) {
      if (buf.length < offset + 4) break;
      offset += 4;
    }
    if (buf.length < offset + len) break;
    frames.push({ opcode, payload: buf.slice(offset, offset + len) });
    buf = buf.slice(offset + len);
  }
  return { frames, rest: buf };
}

function connect(port, path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const clientKey = crypto.randomBytes(16).toString('base64');
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    const messages = [];
    const waiters = [];

    function deliver(msg) {
      if (waiters.length) waiters.shift()(msg);
      else messages.push(msg);
    }

    socket.on('connect', () => {
      socket.write(
        'GET ' + (path || '/') + ' HTTP/1.1\r\n' +
          'Host: 127.0.0.1:' + port + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + clientKey + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buffer.slice(0, idx).toString('utf8');
        if (!/101/.test(head) || head.indexOf(acceptKey(clientKey)) === -1) {
          reject(new Error('bad handshake: ' + head.split('\r\n')[0]));
          return;
        }
        handshakeDone = true;
        buffer = buffer.slice(idx + 4);
      }
      const parsed = decodeFrames(buffer);
      buffer = parsed.rest;
      parsed.frames.forEach((f) => {
        if (f.opcode === 0x1) {
          let payload = f.payload.toString('utf8');
          try {
            payload = JSON.parse(payload);
          } catch (e) {
            /* keep string */
          }
          deliver(payload);
        }
      });
    });

    socket.on('error', reject);

    const api = {
      socket,
      send(text) {
        socket.write(encodeMaskedFrame(0x1, text));
      },
      next(timeoutMs) {
        if (messages.length) return Promise.resolve(messages.shift());
        return new Promise((resolve, reject2) => {
          const timer = setTimeout(() => reject2(new Error('timeout waiting for message')), timeoutMs || 2000);
          waiters.push((m) => {
            clearTimeout(timer);
            resolve(m);
          });
        });
      },
      close() {
        socket.destroy();
      },
    };

    const poll = setInterval(() => {
      if (handshakeDone) {
        clearInterval(poll);
        resolve(api);
      }
    }, 5);
  });
}

(async function main() {
  const srv = await ws.start(PORT);
  console.log('START', typeof srv.port === 'number' && srv.port > 0, 'port=' + srv.port);

  const c1 = await connect(srv.port);
  const c2 = await connect(srv.port);

  // Server sends a `welcome` event on connect.
  const w1 = await c1.next();
  console.log('WELCOME', w1.event === 'welcome', w1.data && w1.data.id ? 'id' : 'no-id');
  await c2.next();

  // Broadcast with emit(event, data) must reach every connected client.
  const n = srv.emit('tick', { price: 42 });
  console.log('EMIT_COUNT', n === 2, 'sent=' + n);

  const m1 = await c1.next();
  const m2 = await c2.next();
  console.log('M1', m1.event === 'tick' && m1.data.price === 42);
  console.log('M2', m2.event === 'tick' && m2.data.price === 42);

  // Targeted emit reaches only the chosen client.
  const n2 = srv.emit('private', { hello: 'you' }, { to: w1.data.id });
  const t1 = await c1.next();
  console.log('TARGETED_COUNT', n2 === 1, 'sent=' + n2);
  console.log('TARGETED', t1.event === 'private' && t1.data.hello === 'you');

  // Client -> server message is observed by the API.
  let received = null;
  srv.on('message', (msg) => {
    received = msg;
  });
  c1.send(JSON.stringify({ event: 'echo', data: 'ping' }));
  await new Promise((r) => setTimeout(r, 60));
  console.log('INBOUND', !!received && received.event === 'echo' && received.data === 'ping');

  console.log('STATS', srv.stats().clients === 2, JSON.stringify(srv.stats()));

  c1.close();
  c2.close();
  await srv.stop();
  console.log('STOP', srv.running === false);
})().catch((err) => {
  console.error('SMOKE_FAIL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
