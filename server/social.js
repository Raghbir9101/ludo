// Friends, presence and room invites for signed-in players, carried over the game WebSocket.
import { publicUser, pairId, MAX_FRIENDS } from './store.js';
import { cleanName } from './auth.js';

const INVITE_GAP_MS = 8000;
const TYPES = new Set(['friends', 'friendAdd', 'friendRespond', 'friendRemove', 'friendSearch', 'invite']);

export class Social {
  constructor({ store, manager }) {
    this.store = store;
    this.manager = manager;
    this.online = new Map(); // userId -> Set(conn)
    this.friendIds = new Map(); // userId -> Set(friend userId), for online users only
    manager.social = this;
  }

  handles(t) {
    return TYPES.has(t);
  }

  async handle(conn, msg) {
    if (!conn.user) return conn.send({ t: 'error', code: 'login', msg: 'Sign in to use friends' });
    const me = conn.user.id;
    switch (msg.t) {
      case 'friends': return this.sendList(me, conn);
      case 'friendAdd': return this.add(conn, msg);
      case 'friendRespond': return this.respond(conn, String(msg.id || ''), !!msg.accept);
      case 'friendRemove': return this.remove(conn, String(msg.id || ''));
      case 'friendSearch': return this.search(conn, msg.q);
      case 'invite': return this.invite(conn, String(msg.id || ''));
    }
  }

  // ---------- presence ----------
  async connected(conn) {
    if (!conn.user) return;
    const id = conn.user.id;
    if (!this.online.has(id)) this.online.set(id, new Set());
    const set = this.online.get(id);
    const first = set.size === 0;
    set.add(conn);
    if (!this.friendIds.has(id)) await this.loadFriendIds(id);
    if (first) this.broadcastPresence(id);
    this.sendList(id, conn);
  }

  disconnected(conn) {
    if (!conn.user) return;
    const id = conn.user.id;
    const set = this.online.get(id);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) {
      this.online.delete(id);
      this.friendIds.delete(id);
    }
    this.broadcastPresence(id);
  }

  // Called by the room manager whenever a connection joins/leaves a room or a room changes phase.
  changed(conn) {
    if (conn?.user) this.broadcastPresence(conn.user.id);
  }

  async loadFriendIds(id) {
    const fs = await this.store.friendshipsOf(id);
    this.friendIds.set(id, new Set(fs.filter((f) => f.status === 'accepted').map((f) => other(f, id))));
  }

  presence(id) {
    const set = this.online.get(id);
    if (!set || !set.size) return { status: 'offline' };
    let best = { status: 'online' };
    for (const c of set) {
      const room = c.room;
      if (!room) continue;
      if (room.phase === 'lobby' && !c.spectator) return { status: 'lobby', room: room.code };
      best = { status: 'playing' };
    }
    return best;
  }

  broadcastPresence(id) {
    const p = this.presence(id);
    for (const [uid, friends] of this.friendIds) {
      if (friends.has(id)) this.sendTo(uid, { t: 'presence', id, ...p });
    }
  }

  sendTo(userId, msg) {
    for (const c of this.online.get(userId) || []) c.send(msg);
  }

  // ---------- lists ----------
  async buildList(me) {
    const [fs, meDoc] = await Promise.all([this.store.friendshipsOf(me), this.store.getUser(me)]);
    const ids = fs.map((f) => other(f, me));
    const users = new Map((await this.store.getUsers(ids)).map((u) => [u._id, u]));
    const friends = [], incoming = [], outgoing = [];
    for (const f of fs) {
      const u = users.get(other(f, me));
      if (!u) continue;
      const pu = publicUser(u);
      if (f.status === 'accepted') friends.push({ ...pu, ...this.presence(u._id) });
      else if (f.from === me) outgoing.push(pu);
      else incoming.push(pu);
    }
    const rank = { lobby: 0, playing: 1, online: 2, offline: 3 };
    friends.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
    const known = new Set([me, ...ids]);
    const suggestions = meDoc?.fbFriends?.length
      ? (await this.store.usersByFacebookIds(meDoc.fbFriends)).filter((u) => !known.has(u._id)).slice(0, 20).map(publicUser)
      : [];
    return { t: 'friends', code: meDoc?.friendCode || null, friends, incoming, outgoing, suggestions };
  }

  async sendList(userId, onlyConn) {
    const list = await this.buildList(userId);
    if (onlyConn) onlyConn.send(list);
    else this.sendTo(userId, list);
  }

  async refreshBoth(a, b) {
    await Promise.all([a, b].map((id) => (this.online.has(id) ? this.loadFriendIds(id) : null)));
    await Promise.all([this.sendList(a), this.sendList(b)]);
  }

  // ---------- actions ----------
  async add(conn, msg) {
    const me = conn.user.id;
    let target = null;
    if (msg.code) target = await this.store.findByFriendCode(String(msg.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8));
    else if (msg.id) target = await this.store.getUser(String(msg.id));
    if (!target) return conn.send({ t: 'error', code: 'friendNotFound', msg: 'No player with that friend code' });
    if (target._id === me) return conn.send({ t: 'error', code: 'friendSelf', msg: "That's your own code" });
    const existing = await this.store.getFriendship(me, target._id);
    if (existing?.status === 'accepted') return conn.send({ t: 'error', code: 'friendAlready', msg: `${target.name} is already your friend` });
    if (existing && existing.from !== me) return this.respond(conn, target._id, true);
    if (existing) return conn.send({ t: 'error', code: 'friendPending', msg: 'Request already sent' });
    const mine = await this.store.friendshipsOf(me);
    if (mine.length >= MAX_FRIENDS) return conn.send({ t: 'error', code: 'friendLimit', msg: 'Friend list is full' });
    await this.store.putFriendship({ _id: pairId(me, target._id), users: [me, target._id], from: me, status: 'pending', createdAt: new Date() });
    conn.send({ t: 'notice', msg: `Friend request sent to ${target.name}` });
    this.sendTo(target._id, { t: 'notice', msg: `${conn.user.name} sent you a friend request`, kind: 'friendRequest' });
    await this.refreshBoth(me, target._id);
  }

  async respond(conn, otherId, accept) {
    const me = conn.user.id;
    const f = await this.store.getFriendship(me, otherId);
    if (!f || f.status !== 'pending' || f.from === me) return;
    if (accept) {
      await this.store.putFriendship({ ...f, status: 'accepted', acceptedAt: new Date() });
      this.sendTo(otherId, { t: 'notice', msg: `${conn.user.name} accepted your friend request` });
    } else {
      await this.store.deleteFriendship(me, otherId);
    }
    await this.refreshBoth(me, otherId);
  }

  async remove(conn, otherId) {
    const me = conn.user.id;
    if (!(await this.store.getFriendship(me, otherId))) return;
    await this.store.deleteFriendship(me, otherId);
    await this.refreshBoth(me, otherId);
  }

  async search(conn, q) {
    const term = cleanName(q);
    if (term.length < 2) return conn.send({ t: 'friendSearch', q: term, results: [] });
    const me = conn.user.id;
    const [users, fs] = await Promise.all([this.store.searchByName(term, 10, me), this.store.friendshipsOf(me)]);
    const rel = new Map(fs.map((f) => [other(f, me), f.status === 'accepted' ? 'friend' : f.from === me ? 'sent' : 'received']));
    conn.send({ t: 'friendSearch', q: term, results: users.map((u) => ({ ...publicUser(u), relation: rel.get(u._id) || null })) });
  }

  async invite(conn, friendId) {
    const me = conn.user.id;
    const room = conn.room;
    if (!room || room.phase !== 'lobby' || conn.spectator) return conn.send({ t: 'error', code: 'inviteNoRoom', msg: 'Create or join a room first' });
    if (!this.friendIds.get(me)?.has(friendId)) return conn.send({ t: 'error', code: 'inviteNotFriend', msg: 'You can only invite friends' });
    if (!this.online.has(friendId)) return conn.send({ t: 'error', code: 'inviteOffline', msg: 'That friend is offline' });
    conn.invites ||= new Map();
    const last = conn.invites.get(friendId) || 0;
    if (Date.now() - last < INVITE_GAP_MS) return;
    conn.invites.set(friendId, Date.now());
    this.sendTo(friendId, {
      t: 'invite', from: { id: me, name: conn.user.name, pic: conn.user.pic },
      code: room.code, n: room.opts.n, teamMode: room.opts.teamMode,
    });
    conn.send({ t: 'notice', msg: 'Invite sent' });
  }

  // A signed-in player renamed themselves.
  async rename(conn, name) {
    if (!conn.user || !name || name === conn.user.name) return;
    conn.user.name = name;
    await this.store.setName(conn.user.id, name);
    for (const c of this.online.get(conn.user.id) || []) if (c.user) c.user.name = name;
  }
}

function other(f, me) {
  return f.users[0] === me ? f.users[1] : f.users[0];
}
