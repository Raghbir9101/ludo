// WebSocket client with automatic reconnect, session token and an outgoing message queue.
import { Emitter } from './emitter.js';
import { prefs, displayName } from './prefs.js';

const SESSION_KEY = 'ludo.session';

export class Net extends Emitter {
  constructor() {
    super();
    this.ws = null;
    this.queue = [];
    this.attempt = 0;
    this.wantOpen = false;
    this.ready = false;
    this.session = localStorage.getItem(SESSION_KEY);
    window.addEventListener('online', () => { if (this.wantOpen && !this.ws) this.open(); });
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
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.ready = false;
    ws.onopen = () => {
      this.attempt = 0;
      ws.send(JSON.stringify({ t: 'hello', session: this.session, name: displayName(), avatar: prefs.avatar }));
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'welcome') {
        this.session = msg.session;
        localStorage.setItem(SESSION_KEY, msg.session);
        this.ready = true;
        const q = this.queue;
        this.queue = [];
        for (const m of q) ws.send(JSON.stringify(m));
        this.emit('status', 'online');
      }
      this.emit(msg.t, msg);
      this.emit('*', msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.emit('status', 'offline');
      if (this.wantOpen) this.scheduleRetry();
    };
    ws.onerror = () => {};
  }

  scheduleRetry() {
    const delay = Math.min(8000, 400 * Math.pow(2, this.attempt++)) + Math.random() * 300;
    this.emit('status', 'reconnecting');
    this.retryTimer = setTimeout(() => this.open(), delay);
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
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }
}

export const net = new Net();
