import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/rooms.js';
import { Social } from '../server/social.js';
import { Auth, parseCookies, safePicture } from '../server/auth.js';
import { MemoryStore, MongoStore, userPic } from '../server/store.js';
import { createServer } from '../server/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
after(async () => { for (const f of cleanup) await f(); });

function world() {
  const store = new MemoryStore();
  const mgr = new RoomManager({ animScale: 0, holdMs: 50, emptyRoomMs: 80, bucketSize: 1000, bucketRate: 1000, chatGapMs: 0, minHumans: 1 });
  const social = new Social({ store, manager: mgr });
  cleanup.push(() => mgr.shutdown());
  return { store, mgr, social };
}

async function user(store, name) {
  const u = await store.upsertOAuth({ provider: 'dev', providerId: name.toLowerCase(), name, picture: null });
  return u;
}

function conn(mgr, u, name = u?.name || 'Guest') {
  const c = {
    inbox: [],
    user: u ? { id: u._id, name: u.name, pic: userPic(u) } : null,
    send(m) { this.inbox.push(JSON.parse(JSON.stringify(m))); },
    close() {},
    last(t) { return [...this.inbox].reverse().find((m) => m.t === t); },
    all(t) { return this.inbox.filter((m) => m.t === t); },
    msg(obj) { mgr.handleRaw(this, JSON.stringify(obj)); },
  };
  mgr.connect(c);
  c.msg({ t: 'hello', name });
  return c;
}

test('friend request by code, accept, presence and invite', async () => {
  const { store, mgr } = world();
  const ua = await user(store, 'Ann');
  const ub = await user(store, 'Bob');
  const a = conn(mgr, ua);
  const b = conn(mgr, ub);
  await sleep(10);
  assert.equal(a.last('friends').code, ua.friendCode);

  a.msg({ t: 'friendAdd', code: ub.friendCode.toLowerCase() });
  await sleep(10);
  assert.deepEqual(a.last('friends').outgoing.map((x) => x.id), [ub._id]);
  assert.deepEqual(b.last('friends').incoming.map((x) => x.name), ['Ann']);
  assert.match(b.last('notice').msg, /Ann sent you a friend request/);

  b.msg({ t: 'friendRespond', id: ua._id, accept: true });
  await sleep(10);
  const fa = a.last('friends').friends;
  assert.equal(fa.length, 1);
  assert.equal(fa[0].name, 'Bob');
  assert.equal(fa[0].status, 'online');

  // Presence follows Bob into a lobby.
  b.msg({ t: 'create', opts: { n: 4 } });
  await sleep(5);
  const code = b.last('room').room.code;
  const p = a.last('presence');
  assert.equal(p.id, ub._id);
  assert.equal(p.status, 'lobby');
  assert.equal(p.room, code);

  // Bob invites Ann; Ann gets the room code.
  b.msg({ t: 'invite', id: ua._id });
  await sleep(5);
  const inv = a.last('invite');
  assert.equal(inv.code, code);
  assert.equal(inv.from.name, 'Bob');

  // Seats carry the account id for "add friend" buttons.
  a.msg({ t: 'join', code });
  const seats = a.last('room').room.seats.filter((s) => s.kind === 'human');
  assert.deepEqual(seats.map((s) => s.uid).sort(), [ua._id, ub._id].sort());

  // Removing ends the friendship for both.
  a.msg({ t: 'friendRemove', id: ub._id });
  await sleep(10);
  assert.equal(a.last('friends').friends.length, 0);
  assert.equal(b.last('friends').friends.length, 0);
});

test('friend rules: guests, self, duplicates, mutual requests, non-friend invites', async () => {
  const { store, mgr } = world();
  const ua = await user(store, 'Cat');
  const ub = await user(store, 'Dan');
  const g = conn(mgr, null, 'Guest');
  g.msg({ t: 'friends' });
  await sleep(5);
  assert.equal(g.last('error').code, 'login');

  const a = conn(mgr, ua);
  const b = conn(mgr, ub);
  a.msg({ t: 'friendAdd', code: ua.friendCode });
  await sleep(5);
  assert.equal(a.last('error').code, 'friendSelf');
  a.msg({ t: 'friendAdd', code: 'ZZZZZZZZ' });
  await sleep(5);
  assert.equal(a.last('error').code, 'friendNotFound');

  a.msg({ t: 'create', opts: { n: 4 } });
  a.msg({ t: 'invite', id: ub._id });
  await sleep(5);
  assert.equal(a.last('error').code, 'inviteNotFriend');
  assert.equal(b.last('invite'), undefined);

  a.msg({ t: 'friendAdd', id: ub._id });
  await sleep(10);
  a.msg({ t: 'friendAdd', id: ub._id });
  await sleep(10);
  assert.equal(a.last('error').code, 'friendPending');
  // Adding someone who already asked you accepts their request.
  b.msg({ t: 'friendAdd', id: ua._id });
  await sleep(10);
  assert.equal(b.last('friends').friends[0].id, ua._id);
});

test('search by name returns relation and excludes yourself', async () => {
  const { store, mgr } = world();
  const ua = await user(store, 'Eve');
  await user(store, 'Evan');
  await user(store, 'Zed');
  const a = conn(mgr, ua);
  a.msg({ t: 'friendSearch', q: 'ev' });
  await sleep(10);
  const r = a.last('friendSearch');
  assert.deepEqual(r.results.map((x) => x.name), ['Evan']);
  assert.equal(r.results[0].relation, null);
});

test('Facebook friends who play show up as suggestions', async () => {
  const { store, mgr } = world();
  const ua = await store.upsertOAuth({ provider: 'facebook', providerId: 'fb1', name: 'Fay', picture: null, fbFriends: ['fb2'] });
  await store.upsertOAuth({ provider: 'facebook', providerId: 'fb2', name: 'Gus', picture: null, fbFriends: ['fb1'] });
  const a = conn(mgr, ua);
  await sleep(10);
  assert.deepEqual(a.last('friends').suggestions.map((x) => x.name), ['Gus']);
});

test('account name and photo replace the guest profile in rooms', async () => {
  const { store, mgr } = world();
  const ua = await store.upsertOAuth({ provider: 'google', providerId: 'g1', name: 'Hana', picture: 'https://lh3.googleusercontent.com/a/x' });
  const a = conn(mgr, ua, 'ignored');
  assert.equal(a.last('welcome').user.name, 'Hana');
  a.msg({ t: 'create', opts: { n: 4 } });
  const me = a.last('room').room.seats[3];
  assert.equal(me.name, 'Hana');
  assert.equal(me.pic, 'https://lh3.googleusercontent.com/a/x');
  a.msg({ t: 'profile', name: 'Hana B', avatar: '🐼' });
  await sleep(5);
  assert.equal((await store.getUser(ua._id)).name, 'Hana B');
});

test('host can set teams, shuffle seats and hand over host', async () => {
  const { mgr } = world();
  const a = conn(mgr, null, 'Ann');
  const b = conn(mgr, null, 'Bob');
  a.msg({ t: 'create', opts: { n: 4, teamMode: true } });
  const code = a.last('room').room.code;
  b.msg({ t: 'join', code });
  assert.deepEqual(a.last('room').room.teams, [0, 1, 0, 1]);
  b.msg({ t: 'setTeam', seat: 0, team: 1 });
  assert.equal(b.last('error').code, 'notHost');
  a.msg({ t: 'setTeam', seat: 1, team: 0 });
  a.msg({ t: 'setTeam', seat: 2, team: 1 });
  assert.deepEqual(a.last('room').room.teams, [0, 0, 1, 1]);

  a.msg({ t: 'shuffleSeats' });
  const names = a.last('room').room.seats.map((s) => s.name).filter(Boolean).sort();
  assert.deepEqual(names, ['Ann', 'Bob']);

  const bSeat = a.last('room').room.seats.findIndex((s) => s.name === 'Bob');
  a.msg({ t: 'makeHost', seat: bSeat });
  assert.equal(b.last('room').room.you.host, true);
  assert.equal(a.last('room').room.you.host, false);

  b.msg({ t: 'ready', on: true });
  a.msg({ t: 'ready', on: true });
  b.msg({ t: 'start' });
  const g = b.last('game');
  assert.deepEqual(g.state.players.map((p) => p.team), [0, 0, 1, 1]);
});

test('helpers: cookies and photo URL allow-list', () => {
  assert.deepEqual(parseCookies('a=1; lp_sid=x%3Dy; b'), { a: '1', lp_sid: 'x=y' });
  assert.equal(safePicture('https://lh3.googleusercontent.com/a/b'), 'https://lh3.googleusercontent.com/a/b');
  assert.equal(safePicture('https://scontent.xx.fbcdn.net/p.jpg'), 'https://scontent.xx.fbcdn.net/p.jpg');
  assert.equal(safePicture('http://lh3.googleusercontent.com/a'), null);
  assert.equal(safePicture('https://evil.example.com/a.png'), null);
  assert.equal(safePicture('javascript:alert(1)'), null);
});

async function listen(env) {
  const { server, manager } = createServer({ animScale: 0 }, { store: new MemoryStore(), env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => { manager.shutdown(); return new Promise((r) => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('dev sign-in sets an HttpOnly session cookie; /api/me and logout', async () => {
  const base = await listen({ DEV_LOGIN: '1' });
  const cfg = await (await fetch(`${base}/auth/config`)).json();
  assert.deepEqual(cfg, { google: false, facebook: false, dev: true });
  assert.equal((await (await fetch(`${base}/api/me`)).json()).user, null);

  const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ivy' }) });
  const set = r.headers.get('set-cookie');
  assert.match(set, /lp_sid=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
  const cookie = set.split(';')[0];
  const me = (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()).user;
  assert.equal(me.name, 'Ivy');
  assert.equal(me.friendCode.length, 8);

  await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal((await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()).user, null);
});

test('dev sign-in is disabled unless DEV_LOGIN=1 and never in production', async () => {
  const base = await listen({ DEV_LOGIN: '1', NODE_ENV: 'production' });
  const r = await fetch(`${base}/auth/dev`, { method: 'POST', body: '{"name":"x"}' });
  assert.equal(r.status, 405);
  assert.equal((await (await fetch(`${base}/auth/config`)).json()).dev, false);
});

test('profile photo: upload, serve, avatar mode, remove, and rejects bad input', async () => {
  const base = await listen({ DEV_LOGIN: '1' });
  const r0 = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pia' }) });
  const cookie = r0.headers.get('set-cookie').split(';')[0];
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);
  const post = (body, extra = {}) => fetch(`${base}/api/me/photo`, { method: 'POST', headers: { cookie, 'Content-Type': 'image/jpeg', ...extra }, body });

  assert.equal((await fetch(`${base}/api/me/photo`, { method: 'POST', body: jpeg })).status, 401);
  assert.equal((await post(jpeg, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(Buffer.from('<svg onload=alert(1)>'))).status, 415);
  assert.equal((await post(Buffer.alloc(300 * 1024, 0xff))).status, 413);

  const up = await post(jpeg);
  assert.equal(up.status, 200);
  const me = (await up.json()).user;
  assert.equal(me.photo, true);
  assert.match(me.pic, /^\/api\/pic\/[a-f0-9]{24}\?v=[a-f0-9]{8}$/);
  const img = await fetch(base + me.pic);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), jpeg);

  const av = await fetch(`${base}/api/me/picmode`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"mode":"avatar"}' });
  assert.equal((await av.json()).user.pic, null);
  const auto = await fetch(`${base}/api/me/picmode`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"mode":"auto"}' });
  assert.equal((await auto.json()).user.pic, me.pic);

  const del = await fetch(`${base}/api/me/photo`, { method: 'DELETE', headers: { cookie } });
  const after = (await del.json()).user;
  assert.equal(after.photo, false);
  assert.equal(after.pic, null);
  assert.equal((await fetch(base + me.pic)).status, 404);
});

test('uploaded photo replaces the provider photo and reaches room seats', async () => {
  const { store, mgr } = world();
  const u = await store.upsertOAuth({ provider: 'google', providerId: 'g9', name: 'Quinn', picture: 'https://lh3.googleusercontent.com/q' });
  await store.setPhoto(u._id, { type: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  const a = conn(mgr, await store.getUser(u._id));
  a.msg({ t: 'create', opts: { n: 4 } });
  assert.match(a.last('room').room.seats[3].pic, /^\/api\/pic\/[a-f0-9]{24}\?v=/);
  await store.setPicMode(u._id, 'avatar');
  assert.equal(userPic(await store.getUser(u._id)), null);
});

test('Google OAuth: state + PKCE checked, profile stored, session created', async () => {
  const store = new MemoryStore();
  const auth = new Auth({ store, env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', PUBLIC_URL: 'https://ludo.test' } });
  const calls = [];
  auth.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = String(url).includes('/token')
      ? { access_token: 'at' }
      : { sub: '1234', name: 'Jo <script>', picture: 'https://lh3.googleusercontent.com/p' };
    return { ok: true, json: async () => body };
  };
  const res = () => {
    const r = { headers: {}, status: 0, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(s, h = {}) { this.status = s; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; return this; }, end() {} };
    return r;
  };
  const r1 = res();
  await auth.handle({ url: '/auth/google', method: 'GET', headers: { host: 'x' } }, r1);
  assert.equal(r1.status, 302);
  const loc = new URL(r1.headers.location);
  assert.equal(loc.hostname, 'accounts.google.com');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://ludo.test/auth/google/callback');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const state = loc.searchParams.get('state');
  const oauthCookie = r1.headers['set-cookie'][0].split(';')[0];
  assert.match(r1.headers['set-cookie'][0], /Secure/);

  const bad = res();
  await auth.handle({ url: `/auth/google/callback?code=c&state=wrong`, method: 'GET', headers: { cookie: oauthCookie } }, bad);
  assert.equal(bad.headers.location, '/?login=failed');
  assert.equal(calls.length, 0);

  const ok = res();
  await auth.handle({ url: `/auth/google/callback?code=c&state=${state}`, method: 'GET', headers: { cookie: oauthCookie } }, ok);
  assert.equal(ok.headers.location, '/?login=ok');
  assert.match(String(calls[0].init.body), /code_verifier=/);
  const sid = ok.headers['set-cookie'].find((c) => c.startsWith('lp_sid=')).split(';')[0].slice(7);
  const u = await store.sessionUser(decodeURIComponent(sid));
  assert.equal(u.google, '1234');
  assert.equal(u.name, 'Jo script');
  assert.equal(u.picture, 'https://lh3.googleusercontent.com/p');
});

test('MongoStore round trip (runs only when MONGODB_URI is set)', { skip: !process.env.MONGODB_URI }, async () => {
  const s = new MongoStore(process.env.MONGODB_URI, `ludo_test_${Date.now()}`);
  cleanup.push(async () => { await s.client?.db(s.dbName).dropDatabase(); await s.close(); });
  await s.ready;
  const a = await s.upsertOAuth({ provider: 'google', providerId: 'm1', name: 'Mona', picture: null });
  const a2 = await s.upsertOAuth({ provider: 'google', providerId: 'm1', name: 'Mona L', picture: null });
  assert.equal(a._id, a2._id);
  assert.equal(a2.name, 'Mona L');
  const b = await s.upsertOAuth({ provider: 'facebook', providerId: 'f1', name: 'Ben', picture: null, fbFriends: [] });
  assert.equal((await s.findByFriendCode(b.friendCode))._id, b._id);
  assert.deepEqual((await s.searchByName('mo', 5, b._id)).map((u) => u._id), [a._id]);
  const tok = await s.createSession(a._id);
  assert.equal((await s.sessionUser(tok))._id, a._id);
  await s.deleteSession(tok);
  assert.equal(await s.sessionUser(tok), null);
  await s.putFriendship({ _id: [a._id, b._id].sort().join(':'), users: [a._id, b._id], from: a._id, status: 'pending', createdAt: new Date() });
  assert.equal((await s.friendshipsOf(b._id)).length, 1);
  await s.deleteFriendship(b._id, a._id);
  assert.equal((await s.getFriendship(a._id, b._id)), null);
  const v = await s.setPhoto(a._id, { type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]) });
  const ph = await s.getPhoto(a._id);
  assert.equal(ph.v, v);
  assert.deepEqual(ph.data, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  assert.equal((await s.getUser(a._id)).photoV, v);
  await s.deletePhoto(a._id);
  assert.equal(await s.getPhoto(a._id), null);
});
