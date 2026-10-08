// Google and Facebook sign-in (OAuth 2.0 authorization-code flow) plus the session cookie.
// Configured entirely through environment variables; a provider is enabled only when its
// client id and secret are both set.
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { publicUser, SESSION_TTL_MS } from './store.js';

const SID = 'lp_sid';
const OAUTH = 'lp_oauth';
const FB_VERSION = 'v19.0';
const PIC_HOSTS = [/\.googleusercontent\.com$/, /\.fbcdn\.net$/, /\.fbsbx\.com$/];

export const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function safePicture(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && PIC_HOSTS.some((re) => re.test(u.hostname)) ? u.href : null;
  } catch {
    return null;
  }
}

const b64url = (buf) => buf.toString('base64url');

export class Auth {
  constructor({ store, env = process.env }) {
    this.store = store;
    this.publicUrl = (env.PUBLIC_URL || '').replace(/\/$/, '');
    this.google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET } : null;
    this.facebook = env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET ? { id: env.FACEBOOK_APP_ID, secret: env.FACEBOOK_APP_SECRET } : null;
    this.devLogin = env.DEV_LOGIN === '1' && env.NODE_ENV !== 'production';
    this.secure = this.publicUrl.startsWith('https:');
    this.fetch = globalThis.fetch;
  }

  base(req) {
    return this.publicUrl || `http://${req.headers.host}`;
  }

  cookie(name, value, maxAgeS) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${this.secure ? '; Secure' : ''}`;
  }

  async userFromReq(req) {
    const sid = parseCookies(req.headers.cookie)[SID];
    if (!sid) return null;
    try {
      return await this.store.sessionUser(sid);
    } catch (err) {
      console.error('session lookup failed', err.message);
      return null;
    }
  }

  // Returns true when the request was an auth route and has been answered.
  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (!p.startsWith('/auth/') && !p.startsWith('/api/')) return false;
    try {
      if (p === '/auth/config' && req.method === 'GET') {
        return json(res, 200, { google: !!this.google, facebook: !!this.facebook, dev: this.devLogin });
      }
      if (p === '/api/me' && req.method === 'GET') {
        return json(res, 200, { user: meView(await this.userFromReq(req)) });
      }
      if (p.startsWith('/api/pic/') && req.method === 'GET') return await this.servePhoto(res, p.slice(9));
      if (p === '/api/me/photo' || p === '/api/me/picmode') return await this.profileWrite(req, res, p);
      if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      if (p === '/auth/logout' && req.method === 'POST') {
        const sid = parseCookies(req.headers.cookie)[SID];
        if (sid) await this.store.deleteSession(sid);
        res.setHeader('Set-Cookie', this.cookie(SID, '', 0));
        return json(res, 200, { ok: true });
      }
      if (p === '/auth/dev' && req.method === 'POST' && this.devLogin) {
        const body = await readJson(req);
        const name = cleanName(body.name);
        if (!name) return json(res, 400, { error: 'name required' });
        const user = await this.store.upsertOAuth({ provider: 'dev', providerId: name.toLowerCase(), name, picture: null });
        await this.startSession(res, user);
        return json(res, 200, { user: meView(user) });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      if (p === '/auth/google' && this.google) return this.begin(req, res, 'google');
      if (p === '/auth/facebook' && this.facebook) return this.begin(req, res, 'facebook');
      if (p === '/auth/google/callback' && this.google) return await this.callback(req, res, url, 'google');
      if (p === '/auth/facebook/callback' && this.facebook) return await this.callback(req, res, url, 'facebook');
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('auth error', p, err.message);
      if (p.endsWith('/callback')) return redirect(res, '/?login=failed', [this.cookie(OAUTH, '', 0)]);
      return json(res, 500, { error: 'server error' });
    }
  }

  async servePhoto(res, id) {
    const ph = /^[a-f0-9]{24}$/.test(id) ? await this.store.getPhoto(id) : null;
    if (!ph) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': ph.type, 'Content-Length': ph.data.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'",
    });
    res.end(ph.data);
    return true;
  }

  // Upload or remove the account photo, or choose photo vs. avatar.
  async profileWrite(req, res, p) {
    const del = req.method === 'DELETE';
    if (req.method !== 'POST' && !(del && p === '/api/me/photo')) return json(res, 405, { error: 'method not allowed' });
    if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
    const u = await this.userFromReq(req);
    if (!u) {
      req.resume();
      return json(res, 401, { error: 'sign in first' });
    }
    if (p === '/api/me/photo' && del) {
      await this.store.deletePhoto(u._id);
    } else if (p === '/api/me/photo') {
      const { buf, tooBig } = await readBody(req, MAX_PHOTO_BYTES);
      if (tooBig) return json(res, 413, { error: 'Photo is too large' });
      const type = sniffImage(buf);
      if (!type) return json(res, 415, { error: 'Use a JPEG, PNG or WebP image' });
      await this.store.setPhoto(u._id, { type, data: buf });
    } else {
      const { mode } = await readJson(req);
      if (mode !== 'auto' && mode !== 'avatar') return json(res, 400, { error: 'bad mode' });
      await this.store.setPicMode(u._id, mode);
    }
    return json(res, 200, { user: meView(await this.store.getUser(u._id)) });
  }

  redirectUri(req, provider) {
    return `${this.base(req)}/auth/${provider}/callback`;
  }

  begin(req, res, provider) {
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const redirectUri = this.redirectUri(req, provider);
    let target;
    if (provider === 'google') {
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      target = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: this.google.id, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile',
        state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
      });
    } else {
      target = `https://www.facebook.com/${FB_VERSION}/dialog/oauth?` + new URLSearchParams({
        client_id: this.facebook.id, redirect_uri: redirectUri, response_type: 'code', scope: 'public_profile,user_friends', state,
      });
    }
    redirect(res, target, [this.cookie(OAUTH, `${provider}.${state}.${verifier}`, 600)]);
    return true;
  }

  async callback(req, res, url, provider) {
    const [savedProvider, savedState, verifier] = String(parseCookies(req.headers.cookie)[OAUTH] || '').split('.');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || savedProvider !== provider || state !== savedState) {
      return redirect(res, '/?login=failed', [this.cookie(OAUTH, '', 0)]);
    }
    const redirectUri = this.redirectUri(req, provider);
    const profile = provider === 'google'
      ? await this.googleProfile(code, verifier, redirectUri)
      : await this.facebookProfile(code, redirectUri);
    const user = await this.store.upsertOAuth({ provider, ...profile });
    const sid = await this.store.createSession(user._id);
    return redirect(res, '/?login=ok', [this.cookie(OAUTH, '', 0), this.cookie(SID, sid, Math.floor(SESSION_TTL_MS / 1000))]);
  }

  async startSession(res, user) {
    const sid = await this.store.createSession(user._id);
    res.setHeader('Set-Cookie', this.cookie(SID, sid, Math.floor(SESSION_TTL_MS / 1000)));
  }

  async googleProfile(code, verifier, redirectUri) {
    const tok = await this.fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: this.google.id, client_secret: this.google.secret, redirect_uri: redirectUri,
        grant_type: 'authorization_code', code_verifier: verifier,
      }),
    });
    const info = await this.fetchJson('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!info.sub) throw new Error('google: no subject');
    return { providerId: String(info.sub), name: cleanName(info.name || info.given_name) || 'Player', picture: safePicture(info.picture) };
  }

  async facebookProfile(code, redirectUri) {
    const tok = await this.fetchJson(`https://graph.facebook.com/${FB_VERSION}/oauth/access_token?` + new URLSearchParams({
      client_id: this.facebook.id, client_secret: this.facebook.secret, redirect_uri: redirectUri, code,
    }));
    const access = tok.access_token;
    const proof = createHmac('sha256', this.facebook.secret).update(access).digest('hex');
    const q = (path, params) => this.fetchJson(`https://graph.facebook.com/${FB_VERSION}${path}?` + new URLSearchParams({ ...params, access_token: access, appsecret_proof: proof }));
    const me = await q('/me', { fields: 'id,name,picture.width(256).height(256)' });
    if (!me.id) throw new Error('facebook: no id');
    // Only friends who also signed in to this app (and granted user_friends) are returned.
    let fbFriends = [];
    try {
      const fr = await q('/me/friends', { limit: '500' });
      fbFriends = (fr.data || []).map((f) => String(f.id)).slice(0, 500);
    } catch { /* permission declined */ }
    const pic = me.picture?.data && !me.picture.data.is_silhouette ? safePicture(me.picture.data.url) : null;
    return { providerId: String(me.id), name: cleanName(me.name) || 'Player', picture: pic, fbFriends };
  }

  async fetchJson(url, init = {}) {
    const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status} ${body.error?.message || body.error || ''}`);
    return body;
  }
}

export const MAX_PHOTO_BYTES = 256 * 1024;

// The signed-in user's own view, including what the profile screen needs.
function meView(u) {
  if (!u) return null;
  return { ...publicUser(u), friendCode: u.friendCode, photo: !!u.photoV, providerPic: u.picture || null, picMode: u.picMode || 'auto' };
}

export function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Cross-site form posts can't carry our SameSite=Lax cookie, but check Origin as well.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

// Reads a raw body; past `limit` it keeps draining (so a 413 can still be sent) but drops the data.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      req.on('end', () => resolve({ buf: null, tooBig: true }));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve(size > limit ? { buf: null, tooBig: true } : { buf: Buffer.concat(chunks), tooBig: false }));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end();
  return true;
}

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}
