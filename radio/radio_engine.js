/**
 * radio/radio_engine.js
 * ==================================================================
 * Socket.io client engine for the race-radio subsystem.
 *
 * Purpose
 * -------
 * The radio engine is the transport layer between the AEON race
 * coordination core and the radio backend. It:
 *
 *   - Connects (optionally) to the radio backend at 127.0.0.1:3020.
 *   - Exposes the two public API entry points required by the spec:
 *
 *       emitRadio(event)               -> append an event to the stream
 *                                         (and broadcast it on the wire).
 *       listenRace(raceId, callback)   -> subscribe to `race:tick`
 *                                         events for a specific race.
 *
 *   - Keeps an in-memory, bounded ring-buffer ("stream") of events so
 *     that late subscribers and diagnostics can inspect recent traffic.
 *   - Handles reconnection, heartbeats and error isolation.
 *
 * Design notes
 * ------------
 * The module is dependency-light: the only hard dependency is the
 * `socket.io-client` package. When it is not installed the engine keeps
 * working in "local mode" (events are still buffered, nothing is sent)
 * instead of throwing at require-time. This keeps unit tests and CI
 * hermetic.
 *
 * Author: AEON / radio guild
 * ==================================================================
 */

'use strict';

const EventEmitter = require('events');

// ------------------------------------------------------------------
// Configuration constants
// ------------------------------------------------------------------

/** Default radio backend host. */
const DEFAULT_HOST = process.env.RADIO_HOST || '127.0.0.1';

/** Default radio backend port (the spec pins this to 3020). */
const DEFAULT_PORT = parseInt(process.env.RADIO_PORT || '3020', 10);

/** Maximum number of events retained in the stream ring buffer. */
const DEFAULT_STREAM_LIMIT = 500;

/** Interval (ms) between synthetic `radio:heartbeat` frames. */
const HEARTBEAT_INTERVAL_MS = 15000;

/** socket.io reconnection backoff (ms). */
const RECONNECTION_DELAY_MS = 500;
const RECONNECTION_DELAY_MAX_MS = 5000;

/** socket.io connection timeout (ms). */
const CONNECTION_TIMEOUT_MS = 8000;

/** Events the engine knows how to consume from the backend. */
const INBOUND_EVENTS = ['race:tick', 'race:overtake', 'race:lap', 'race:finish'];

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Attempt to load `socket.io-client`. Returns `null` when the package is
 * unavailable so the caller can degrade to local-only mode.
 *
 * @returns {Function|null}
 */
function loadSocketIo() {
  try {
    // eslint-disable-next-line global-require
    return require('socket.io-client');
  } catch (err) {
    return null;
  }
}

/**
 * Generate a reasonably unique id for an event envelope.
 * @returns {string}
 */
function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalise an arbitrary input into a consistent event envelope so that
 * every consumer of the stream observes the same object shape.
 *
 * Object  -> merged with `{ id, ts, engine, type }`
 * String  -> `{ type: 'text', text: <string>, engine: 'radio_engine' }`
 * Other   -> `{ type: 'radio:event', payload: <value>, engine: ... }`
 *
 * @param {*} event
 * @returns {object}
 */
function normaliseEvent(event) {
  const now = Date.now();

  const base = {
    id: makeId(),
    ts: now,
    engine: 'radio_engine',
  };

  if (event && typeof event === 'object' && !Array.isArray(event)) {
    return Object.assign(base, { type: 'radio:event' }, event);
  }

  if (typeof event === 'string') {
    return Object.assign(base, {
      type: 'text',
      text: event,
      payload: event,
    });
  }

  return Object.assign(base, {
    type: 'radio:event',
    text: event === undefined || event === null ? '' : String(event),
    payload: event,
  });
}

/**
 * Best-effort string coercion for ids coming from the wire.
 * @param {*} value
 * @returns {string}
 */
function toId(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

// ------------------------------------------------------------------
// RadioEngine
// ------------------------------------------------------------------

/**
 * Radio transport engine.
 *
 * @fires RadioEngine#connected
 * @fires RadioEngine#disconnected
 * @fires RadioEngine#stream
 * @fires RadioEngine#race:tick
 * @fires RadioEngine#error
 */
class RadioEngine extends EventEmitter {
  /**
   * @param {object}   [options]
   * @param {string}   [options.host]        backend host (default 127.0.0.1)
   * @param {number}   [options.port]        backend port (default 3020)
   * @param {number}   [options.streamLimit] ring-buffer capacity
   * @param {boolean}  [options.autoConnect] connect immediately on creation
   * @param {object}   [options.socketOptions] extra socket.io options
   */
  constructor(options = {}) {
    super();

    this.host = options.host || DEFAULT_HOST;
    this.port = options.port || DEFAULT_PORT;
    this.streamLimit = options.streamLimit || DEFAULT_STREAM_LIMIT;
    this.socketOptions = options.socketOptions || {};

    /** @type {Array<object>} bounded ring buffer of events. */
    this.stream = [];

    /** @type {Map<string, Set<Function>>} raceId -> callbacks. */
    this.raceSubscriptions = new Map();

    /** @type {Map<Function, {id:string, callback:Function}>} off-token registry. */
    this._offTokens = new Map();

    this.socket = null;
    this.connected = false;
    this.localMode = false;
    this.lastError = null;

    this._emitted = 0;
    this._heartbeatTimer = null;

    /**
     * Lazily resolved socket.io-client factory. `null` when the package
     * is not installed, in which case the engine runs in local mode.
     * @type {Function|null}
     */
    this.io = loadSocketIo();

    if (options.autoConnect === true) {
      this.connect();
    }
  }

  // ----------------------------------------------------------------
  // Connection lifecycle
  // ----------------------------------------------------------------

  /**
   * socket.io endpoint URL derived from the configured host/port.
   * @returns {string}
   */
  get url() {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * Establish the connection to the radio backend. Idempotent: calling
   * it twice returns the existing socket. When `socket.io-client` is not
   * available the engine switches to local mode.
   *
   * @returns {RadioEngine}
   */
  connect() {
    if (this.socket) {
      return this;
    }

    if (!this.io) {
      this.localMode = true;
      this.emit('local', { reason: 'socket.io-client not installed' });
      return this;
    }

    this.socket = this.io(this.url, Object.assign(
      {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: RECONNECTION_DELAY_MS,
        reconnectionDelayMax: RECONNECTION_DELAY_MAX_MS,
        timeout: CONNECTION_TIMEOUT_MS,
      },
      this.socketOptions
    ));

    this.socket.on('connect', () => this._onConnect());
    this.socket.on('disconnect', (reason) => this._onDisconnect(reason));
    this.socket.on('connect_error', (err) => this._onConnectError(err));

    // Inbound race traffic is funnelled through the same normaliser so
    // local subscribers and the stream stay in sync.
    INBOUND_EVENTS.forEach((name) => {
      this.socket.on(name, (payload) => this._handleRaceTick(payload, name));
    });

    return this;
  }

  /** @private */
  _onConnect() {
    this.connected = true;
    this.localMode = false;
    this.lastError = null;
    this._startHeartbeat();
    this.emit('connected', { url: this.url });
  }

  /** @private */
  _onDisconnect(reason) {
    this.connected = false;
    this._stopHeartbeat();
    this.emit('disconnected', { reason });
  }

  /** @private */
  _onConnectError(err) {
    this.connected = false;
    this._safeError(err instanceof Error ? err : new Error(String(err)));
  }

  /**
   * Emit an `error` event only when someone is listening; otherwise the
   * EventEmitter would throw and crash the host process.
   * @private
   */
  _safeError(err) {
    this.lastError = err instanceof Error ? err : new Error(String(err));
    if (this.listenerCount('error') > 0) {
      this.emit('error', this.lastError);
    }
  }

  /** @private */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this.socket && this.connected) {
        this.socket.emit('radio:heartbeat', { ts: Date.now() });
      }
    }, HEARTBEAT_INTERVAL_MS);
    if (this._heartbeatTimer.unref) {
      this._heartbeatTimer.unref();
    }
  }

  /** @private */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Close the socket and release all timers/subscriptions.
   * @returns {RadioEngine}
   */
  disconnect() {
    this._stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.close();
      } catch (err) {
        // disconnect is best-effort; swallow transport errors
      }
      this.socket = null;
    }
    this.connected = false;
    this.raceSubscriptions.clear();
    this._offTokens.clear();
    this.emit('closed', { ts: Date.now() });
    return this;
  }

  // ----------------------------------------------------------------
  // Stream management
  // ----------------------------------------------------------------

  /**
   * Append an event to the bounded stream buffer.
   * @param {object|string} event
   * @returns {object} the normalised event envelope
   */
  pushToStream(event) {
    const normalised = normaliseEvent(event);
    this.stream.push(normalised);

    if (this.stream.length > this.streamLimit) {
      this.stream.splice(0, this.stream.length - this.streamLimit);
    }

    this.emit('stream', normalised);
    return normalised;
  }

  /**
   * Return a copy of the stream buffer.
   * @param {number} [limit] when provided, return only the last `limit` items
   * @returns {Array<object>}
   */
  getStream(limit) {
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      return this.stream.slice(-limit);
    }
    return this.stream.slice();
  }

  /**
   * Clear the stream buffer.
   * @returns {number} the number of events that were dropped
   */
  clearStream() {
    const dropped = this.stream.length;
    this.stream = [];
    return dropped;
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * emitRadio(event) — add an event to the local stream and, when
   * connected, broadcast it to the radio backend as `radio:event`.
   *
   * @param {object|string} event
   * @returns {object} the stored event envelope
   */
  emitRadio(event) {
    const stored = this.pushToStream(event);
    this._emitted += 1;

    if (this.socket && this.connected) {
      try {
        this.socket.emit('radio:event', stored);
      } catch (err) {
        this._safeError(err);
      }
    }

    return stored;
  }

  /**
   * Non-throwing variant of {@link RadioEngine#emitRadio}, handy inside
   * hot loops where a transport hiccup must not abort the caller.
   *
   * @param {object|string} event
   * @returns {object|null} the stored envelope, or `null` on failure
   */
  emitRadioSafe(event) {
    try {
      return this.emitRadio(event);
    } catch (err) {
      this._safeError(err);
      return null;
    }
  }

  /**
   * listenRace(raceId, callback) — subscribe to `race:tick` events for a
   * specific race. The callback is invoked as `callback(tick, raceId)`.
   *
   * @param {string}   raceId
   * @param {Function} callback
   * @returns {Function} unsubscribe token (also accepted by unlistenRace)
   */
  listenRace(raceId, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('listenRace(raceId, callback): callback must be a function');
    }

    const id = toId(raceId);

    if (!this.raceSubscriptions.has(id)) {
      this.raceSubscriptions.set(id, new Set());
      // Ask the backend to start streaming this race to us.
      if (this.socket && this.connected) {
        this.socket.emit('race:subscribe', { raceId: id });
      }
    }

    this.raceSubscriptions.get(id).add(callback);

    // Build a stable off-token so callers may either invoke it directly
    // or hand it back to unlistenRace().
    const off = () => this.unlistenRace(id, off);
    off._raceId = id;
    off._callback = callback;
    this._offTokens.set(off, { id, callback });

    return off;
  }

  /**
   * Remove a previously registered race callback.
   *
   * @param {string}   raceId
   * @param {Function} target either the original callback or the token
   *                          returned by {@link RadioEngine#listenRace}
   * @returns {boolean} true when a callback was removed
   */
  unlistenRace(raceId, target) {
    const id = toId(raceId || (target && target._raceId));
    const callback = (target && target._callback) || target;

    const subs = this.raceSubscriptions.get(id);
    if (!subs || typeof callback !== 'function') {
      return false;
    }

    const removed = subs.delete(callback);
    if (target) {
      this._offTokens.delete(target);
    }

    if (subs.size === 0) {
      this.raceSubscriptions.delete(id);
      if (this.socket && this.connected) {
        this.socket.emit('race:unsubscribe', { raceId: id });
      }
    }

    return removed;
  }

  /**
   * Remove every subscriber for a race.
   * @param {string} raceId
   * @returns {number} how many callbacks were removed
   */
  unlistenAll(raceId) {
    const id = toId(raceId);
    const subs = this.raceSubscriptions.get(id);
    if (!subs) {
      return 0;
    }
    const count = subs.size;
    this.raceSubscriptions.delete(id);
    if (this.socket && this.connected) {
      this.socket.emit('race:unsubscribe', { raceId: id });
    }
    return count;
  }

  /**
   * Normalise an inbound race payload, buffer it, and dispatch it to all
   * interested subscribers.
   *
   * @param {object} payload
   * @param {string} [wireEvent='race:tick'] the socket.io event name
   * @returns {object|null} the normalised tick, or null for invalid input
   */
  _handleRaceTick(payload, wireEvent) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const raceId = toId(payload.raceId || payload.race_id || payload.race);
    const tick = Object.assign({}, payload, {
      type: 'race:tick',
      wireEvent: wireEvent || 'race:tick',
      raceId,
    });

    this.pushToStream(tick);

    // Session-level (global) listeners fire regardless of raceId.
    this.emit('race:tick', tick, raceId);

    if (!raceId) {
      return tick;
    }

    const subs = this.raceSubscriptions.get(raceId);
    if (subs && subs.size > 0) {
      subs.forEach((cb) => {
        try {
          cb(tick, raceId);
        } catch (err) {
          this._safeError(err);
        }
      });
    }

    return tick;
  }

  /**
   * Alias kept for socket.io wiring / backwards compatibility.
   * @param {object} payload
   * @returns {object|null}
   */
  _onRaceTick(payload) {
    return this._handleRaceTick(payload, 'race:tick');
  }

  /**
   * Number of active race subscriptions.
   * @returns {number}
   */
  get subscriptionCount() {
    return this.raceSubscriptions.size;
  }

  /**
   * Runtime statistics (handy for health checks and tests).
   * @returns {object}
   */
  getStats() {
    return {
      url: this.url,
      connected: this.connected,
      localMode: this.localMode,
      emitted: this._emitted,
      streamSize: this.stream.length,
      streamLimit: this.streamLimit,
      subscriptions: this.subscriptionCount,
      lastError: this.lastError ? String(this.lastError.message || this.lastError) : null,
    };
  }

  /**
   * Human-readable snapshot of engine state.
   * @returns {object}
   */
  status() {
    return Object.assign({ mode: this.localMode ? 'local' : 'socket' }, this.getStats());
  }
}

// ------------------------------------------------------------------
// Module-level singleton + factory
// ------------------------------------------------------------------

/**
 * Create a fresh engine instance.
 *
 * Auto-connect is disabled by default so that requiring this module or
 * constructing an engine in tests never attempts a network connection.
 * Pass `{ autoConnect: true }` to connect immediately.
 *
 * @param {object} [options]
 * @returns {RadioEngine}
 */
function createEngine(options = {}) {
  return new RadioEngine(Object.assign({ autoConnect: false }, options));
}

/** Shared default engine (local mode unless explicitly connected). */
const defaultEngine = createEngine();

/**
 * Module-level emitRadio bound to the shared default engine.
 * @param {object|string} event
 * @returns {object}
 */
function emitRadio(event) {
  return defaultEngine.emitRadio(event);
}

/**
 * Module-level listenRace bound to the shared default engine.
 * @param {string} raceId
 * @param {Function} callback
 * @returns {Function}
 */
function listenRace(raceId, callback) {
  return defaultEngine.listenRace(raceId, callback);
}

module.exports = {
  RadioEngine,
  createEngine,
  emitRadio,
  listenRace,
  normaliseEvent,
  defaultEngine,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_STREAM_LIMIT,
  HEARTBEAT_INTERVAL_MS,
  INBOUND_EVENTS,
};
