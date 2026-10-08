// Signed-in account (Google / Facebook). Guests have account.user === null.
import { Emitter } from './emitter.js';
import { savePrefs } from './prefs.js';
import { net } from './net.js';

class Account extends Emitter {
  constructor() {
    super();
    this.user = null;
    this.providers = { google: false, facebook: false, dev: false };
    this.loaded = false;
  }

  async load() {
    try {
      const get = (u) => fetch(u, { cache: 'no-store', credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
      const [cfg, me] = await Promise.all([get('/auth/config'), get('/api/me')]);
      this.providers = cfg;
      this.set(me.user);
    } catch {
      // Offline or server unreachable: stay a guest.
    }
    this.loaded = true;
    this.emit('change', this.user);
    return this.user;
  }

  set(user) {
    this.user = user || null;
    if (this.user) savePrefs({ name: this.user.name });
  }

  get anyProvider() {
    return this.providers.google || this.providers.facebook || this.providers.dev;
  }

  signIn(provider) {
    location.href = `/auth/${provider}`;
  }

  async devSignIn(name) {
    const r = await fetch('/auth/dev', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error('sign-in failed');
    await this.load();
    net.reconnect();
  }

  // Profile photo changes. Reconnecting makes rooms and friends see the new picture.
  async uploadPhoto(blob) {
    return this.profileCall('/api/me/photo', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  }

  async removePhoto() {
    return this.profileCall('/api/me/photo', { method: 'DELETE' });
  }

  async setPicMode(mode) {
    return this.profileCall('/api/me/picmode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
  }

  async profileCall(url, init) {
    const r = await fetch(url, { ...init, credentials: 'same-origin' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'Could not update your photo');
    this.user = body.user || null;
    this.emit('change', this.user);
    net.reconnect();
    return this.user;
  }

  async signOut() {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    this.user = null;
    this.emit('change', null);
    net.reconnect();
  }
}

export const account = new Account();
