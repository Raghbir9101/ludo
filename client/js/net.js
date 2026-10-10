// WebSocket client with automatic reconnect, session token and an outgoing message queue.
// Mobile networks drop sockets silently, so a ping watchdog detects dead connections and the
// app reconnects at once when it comes back to the foreground or the network returns.
import { Emitter } from './emitter.js';
import { prefs, displayName } from './prefs.js';

const SESSION_KEY = 'ludo.session';
const PING_MS = 15_000;
const DEAD_MS = 40_000;

export class Net extends Emitter {
  constructor() {
    super();
    this.ws = null;
    this.queue = [];
    this.attempt = 0;
    this.wantOpen = false;
    this.ready = false;
    this.lastMsgAt = 0;
    this.session = localStorage.getItem(SESSION_KEY);
    const wake = () => this.wake();
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
    setInterval(() => this.watchdog(), PING_MS);
  }

  get url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  connect() {
    this.wantOpen = true;
    if (this.ws) return;
    this.open();
  }

  open() {
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.ready = false;
    this.lastMsgAt = Date.now();
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', session: this.session, name: displayName(), avatar: prefs.avatar }));
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastMsgAt = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'welcome') {
        this.attempt = 0;
        this.session = msg.session;
        localStorage.setItem(SESSION_KEY, msg.session);
        this.ready = true;
        const q = this.queue;
        this.queue = [];
        for (const m of q) ws.send(JSON.stringify(m));
        this.emit('status', 'online');
      }
      // Another tab or device took over this account's seat: don't fight it for the socket.
      if (msg.t === 'left' && msg.reason === 'elsewhere') this.wantOpen = false;
      this.emit(msg.t, msg);
      this.emit('*', msg);
    };
    ws.onclose = () => this.dropped(ws);
    ws.onerror = () => {};
  }

  dropped(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.ready = false;
    this.emit('status', 'offline');
    if (this.wantOpen) this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.retryTimer) return;
    const delay = Math.min(8000, 400 * Math.pow(2, this.attempt++)) + Math.random() * 300;
    this.emit('status', 'reconnecting');
    this.retryTimer = setTimeout(() => { this.retryTimer = 0; this.open(); }, delay);
  }

  // Foreground / network back: retry now instead of waiting out the backoff, and check
  // that an apparently open socket is still alive.
  wake() {
    if (!this.wantOpen || document.hidden) return;
    if (!this.ws) {
      this.attempt = 0;
      clearTimeout(this.retryTimer);
      this.retryTimer = 0;
      this.open();
    } else if (this.ready) {
      this.ws.send(JSON.stringify({ t: 'ping', at: Date.now() }));
    }
  }

  watchdog() {
    const ws = this.ws;
    if (!ws || document.hidden) return;
    if (Date.now() - this.lastMsgAt > DEAD_MS) {
      try { ws.close(); } catch { /* already closing */ }
      this.attempt = 0;
      this.dropped(ws);
      return;
    }
    if (this.ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping', at: Date.now() }));
  }

  send(t, payload = {}) {
    const msg = { t, ...payload };
    if (this.ws && this.ready && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      if (this.queue.length > 50) this.queue.shift();
      this.queue.push(msg);
      this.connect();
    }
  }

  // Drop queued game intents (they'd be stale after a reconnect).
  dropQueued(types) {
    this.queue = this.queue.filter((m) => !types.includes(m.t));
  }

  // Re-open the socket so the server re-reads the login cookie.
  reconnect() {
    const want = this.wantOpen;
    this.close();
    if (want) this.connect();
  }

  close() {
    this.wantOpen = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.ready = false;
      ws.close();
    }
  }
}

export const net = new Net();
