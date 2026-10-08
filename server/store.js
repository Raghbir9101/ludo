// Persistent accounts, login sessions and friendships.
// MongoStore is used when MONGODB_URI is set; MemoryStore keeps the same interface for
// development and tests (data is lost on restart).
import { randomBytes, createHash } from 'node:crypto';

const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const MAX_FRIENDS = 200;

export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const pairId = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const newId = () => randomBytes(12).toString('hex');
export function newFriendCode() {
  let s = '';
  const buf = randomBytes(8);
  for (let i = 0; i < 8; i++) s += FRIEND_CODE_ALPHABET[buf[i] % FRIEND_CODE_ALPHABET.length];
  return s;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Photo shown for a user: an uploaded photo beats the Google/Facebook one; picMode 'avatar'
// hides both so the emoji avatar is used.
export function userPic(u) {
  if (!u || u.picMode === 'avatar') return null;
  if (u.photoV) return `/api/pic/${u._id}?v=${u.photoV}`;
  return u.picture || null;
}

// Public view of a user, safe to send to other players.
export function publicUser(u) {
  return u ? { id: u._id, name: u.name, pic: userPic(u) } : null;
}

const photoVersion = () => randomBytes(4).toString('hex');

// ---------- memory ----------
export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.users = new Map();
    this.sessions = new Map();
    this.friendships = new Map();
    this.photos = new Map();
  }

  async setPhoto(id, { type, data }) {
    const u = this.users.get(String(id));
    if (!u) return null;
    const v = photoVersion();
    this.photos.set(u._id, { type, data: Buffer.from(data), v });
    Object.assign(u, { photoV: v, picMode: 'auto' });
    return v;
  }

  async getPhoto(id) {
    return this.photos.get(String(id)) || null;
  }

  async deletePhoto(id) {
    this.photos.delete(String(id));
    const u = this.users.get(String(id));
    if (u) delete u.photoV;
  }

  async setPicMode(id, mode) {
    const u = this.users.get(String(id));
    if (u) u.picMode = mode;
  }

  async upsertOAuth({ provider, providerId, name, picture, fbFriends }) {
    let u = [...this.users.values()].find((x) => x[provider] === providerId);
    if (!u) {
      let code;
      do code = newFriendCode(); while ([...this.users.values()].some((x) => x.friendCode === code));
      u = { _id: newId(), [provider]: providerId, name, nameLower: name.toLowerCase(), friendCode: code, createdAt: new Date() };
      this.users.set(u._id, u);
    }
    if (!u.customName) { u.name = name; u.nameLower = name.toLowerCase(); }
    u.picture = picture;
    if (fbFriends) u.fbFriends = fbFriends;
    u.lastLogin = new Date();
    return { ...u };
  }

  async getUser(id) {
    const u = this.users.get(String(id));
    return u ? { ...u } : null;
  }

  async getUsers(ids) {
    return ids.map((id) => this.users.get(String(id))).filter(Boolean).map((u) => ({ ...u }));
  }

  async findByFriendCode(code) {
    const u = [...this.users.values()].find((x) => x.friendCode === code);
    return u ? { ...u } : null;
  }

  async searchByName(q, limit, excludeId) {
    const p = q.toLowerCase();
    return [...this.users.values()].filter((u) => u._id !== excludeId && u.nameLower.startsWith(p)).slice(0, limit).map((u) => ({ ...u }));
  }

  async usersByFacebookIds(fbIds) {
    const set = new Set(fbIds);
    return [...this.users.values()].filter((u) => u.facebook && set.has(u.facebook)).map((u) => ({ ...u }));
  }

  async setName(id, name) {
    const u = this.users.get(String(id));
    if (u) Object.assign(u, { name, nameLower: name.toLowerCase(), customName: true });
  }

  async createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(hashToken(token), { userId, expires: Date.now() + SESSION_TTL_MS });
    return token;
  }

  async sessionUser(token) {
    if (!token) return null;
    const s = this.sessions.get(hashToken(token));
    if (!s || s.expires < Date.now()) return null;
    return this.getUser(s.userId);
  }

  async deleteSession(token) {
    this.sessions.delete(hashToken(token));
  }

  async friendshipsOf(userId) {
    return [...this.friendships.values()].filter((f) => f.users.includes(userId)).map((f) => ({ ...f }));
  }

  async getFriendship(a, b) {
    const f = this.friendships.get(pairId(a, b));
    return f ? { ...f } : null;
  }

  async putFriendship(f) {
    this.friendships.set(f._id, { ...f });
  }

  async deleteFriendship(a, b) {
    this.friendships.delete(pairId(a, b));
  }
}

// ---------- MongoDB ----------
export class MongoStore {
  constructor(uri, dbName) {
    this.kind = 'mongo';
    this.uri = uri;
    this.dbName = dbName;
    this.ready = this.init();
    this.ready.catch((err) => console.error('MongoDB connection failed:', err.message));
  }

  async init() {
    const { MongoClient } = await import('mongodb');
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 8000 });
    await this.client.connect();
    const db = this.client.db(this.dbName || undefined);
    this.u = db.collection('users');
    this.s = db.collection('sessions');
    this.f = db.collection('friendships');
    this.p = db.collection('photos');
    await Promise.all([
      this.u.createIndex({ google: 1 }, { unique: true, sparse: true }),
      this.u.createIndex({ facebook: 1 }, { unique: true, sparse: true }),
      this.u.createIndex({ friendCode: 1 }, { unique: true }),
      this.u.createIndex({ nameLower: 1 }),
      this.s.createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
      this.f.createIndex({ users: 1 }),
    ]);
    return true;
  }

  async upsertOAuth({ provider, providerId, name, picture, fbFriends }) {
    await this.ready;
    const now = new Date();
    const set = { picture, lastLogin: now };
    if (fbFriends) set.fbFriends = fbFriends;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const u = await this.u.findOneAndUpdate(
          { [provider]: providerId },
          {
            $set: set,
            $setOnInsert: { _id: newId(), [provider]: providerId, friendCode: newFriendCode(), createdAt: now },
          },
          { upsert: true, returnDocument: 'after' },
        );
        if (!u.customName) {
          await this.u.updateOne({ _id: u._id }, { $set: { name, nameLower: name.toLowerCase() } });
          u.name = name;
          u.nameLower = name.toLowerCase();
        }
        return u;
      } catch (err) {
        if (err?.code !== 11000) throw err; // retry only on a friend-code collision
      }
    }
    throw new Error('could not allocate a friend code');
  }

  async getUser(id) {
    await this.ready;
    return this.u.findOne({ _id: String(id) });
  }

  async getUsers(ids) {
    await this.ready;
    if (!ids.length) return [];
    return this.u.find({ _id: { $in: ids.map(String) } }).toArray();
  }

  async findByFriendCode(code) {
    await this.ready;
    return this.u.findOne({ friendCode: code });
  }

  async searchByName(q, limit, excludeId) {
    await this.ready;
    return this.u.find({ nameLower: { $regex: `^${escapeRe(q.toLowerCase())}` }, _id: { $ne: excludeId } }).limit(limit).toArray();
  }

  async usersByFacebookIds(fbIds) {
    await this.ready;
    if (!fbIds.length) return [];
    return this.u.find({ facebook: { $in: fbIds } }).limit(MAX_FRIENDS).toArray();
  }

  async setName(id, name) {
    await this.ready;
    await this.u.updateOne({ _id: String(id) }, { $set: { name, nameLower: name.toLowerCase(), customName: true } });
  }

  async createSession(userId) {
    await this.ready;
    const token = randomBytes(32).toString('base64url');
    await this.s.insertOne({ _id: hashToken(token), userId, expires: new Date(Date.now() + SESSION_TTL_MS) });
    return token;
  }

  async sessionUser(token) {
    if (!token) return null;
    await this.ready;
    const s = await this.s.findOne({ _id: hashToken(token) });
    if (!s || s.expires < new Date()) return null;
    return this.getUser(s.userId);
  }

  async deleteSession(token) {
    await this.ready;
    await this.s.deleteOne({ _id: hashToken(token) });
  }

  async friendshipsOf(userId) {
    await this.ready;
    return this.f.find({ users: userId }).limit(MAX_FRIENDS * 2).toArray();
  }

  async getFriendship(a, b) {
    await this.ready;
    return this.f.findOne({ _id: pairId(a, b) });
  }

  async putFriendship(f) {
    await this.ready;
    await this.f.replaceOne({ _id: f._id }, f, { upsert: true });
  }

  async deleteFriendship(a, b) {
    await this.ready;
    await this.f.deleteOne({ _id: pairId(a, b) });
  }

  async setPhoto(id, { type, data }) {
    await this.ready;
    const v = photoVersion();
    await this.p.replaceOne({ _id: String(id) }, { _id: String(id), type, data: Buffer.from(data), v, updatedAt: new Date() }, { upsert: true });
    await this.u.updateOne({ _id: String(id) }, { $set: { photoV: v, picMode: 'auto' } });
    return v;
  }

  async getPhoto(id) {
    await this.ready;
    const p = await this.p.findOne({ _id: String(id) });
    if (!p) return null;
    const bytes = p.data?._bsontype === 'Binary' ? p.data.buffer : p.data;
    return { type: p.type, data: Buffer.from(bytes), v: p.v };
  }

  async deletePhoto(id) {
    await this.ready;
    await this.p.deleteOne({ _id: String(id) });
    await this.u.updateOne({ _id: String(id) }, { $unset: { photoV: '' } });
  }

  async setPicMode(id, mode) {
    await this.ready;
    await this.u.updateOne({ _id: String(id) }, { $set: { picMode: mode } });
  }

  async close() {
    await this.client?.close();
  }
}

export function createStore(env = process.env) {
  if (env.MONGODB_URI) return new MongoStore(env.MONGODB_URI, env.MONGODB_DB);
  if (env.NODE_ENV === 'production') console.warn('WARNING: MONGODB_URI is not set; accounts and friends are kept in memory and lost on restart.');
  return new MemoryStore();
}
