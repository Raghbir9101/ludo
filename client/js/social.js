// Friends list and presence pushed by the server; shared by the friends screen and the lobby.
import { Emitter } from './emitter.js';
import { net } from './net.js';

class Social extends Emitter {
  constructor() {
    super();
    this.list = null;
    net.on('friends', (m) => {
      this.list = m;
      this.emit('change');
    });
    net.on('presence', (m) => {
      const f = this.list?.friends.find((x) => x.id === m.id);
      if (!f) return;
      f.status = m.status;
      f.room = m.room;
      this.emit('change');
    });
  }

  relation(uid) {
    const l = this.list;
    if (!l || !uid) return null;
    if (l.friends.some((f) => f.id === uid)) return 'friend';
    if (l.outgoing.some((f) => f.id === uid)) return 'sent';
    if (l.incoming.some((f) => f.id === uid)) return 'received';
    return null;
  }

  get requestCount() {
    return this.list?.incoming.length || 0;
  }

  clear() {
    this.list = null;
    this.emit('change');
  }
}

export const social = new Social();
