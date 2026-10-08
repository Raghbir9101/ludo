// Profile screen: name, avatar, account photo (signed-in users) and sign-in/out.
import { $, h, avatarEl, toast } from './dom.js';
import { prefs, savePrefs, AVATARS, displayName } from '../prefs.js';
import { audio } from '../audio.js';
import { account } from '../account.js';
import { social } from '../social.js';

const PHOTO_PX = 256;

// Center-crops to a square and re-encodes as JPEG, so uploads are small and carry no metadata.
async function squarePhoto(file) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = PHOTO_PX;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
  bmp.close?.();
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.86));
}

export function profileScreen({ onProfileChange }) {
  const name = $('#set-name');
  const file = $('#photo-file');
  const use = $('#photo-use');
  let busy = false;

  function renderPreview() {
    const u = account.user;
    $('#profile-preview').replaceChildren(avatarEl({ pic: u?.pic, avatar: prefs.avatar }, 'avatar huge'));
    $('#profile-name-view').textContent = displayName();
    $('#profile-sub').textContent = u ? `Friend code ${social.list?.code || u.friendCode || ''}` : 'Playing as a guest';
  }

  function renderAvatars() {
    $('#set-avatars').replaceChildren(...AVATARS.map((a) => {
      const b = h('button', { type: 'button', class: 'avatar-opt', role: 'radio', 'aria-checked': String(prefs.avatar === a), 'aria-label': `Avatar ${a}` }, a);
      b.addEventListener('click', async () => {
        savePrefs({ avatar: a });
        audio.play('tap');
        renderAvatars();
        renderPreview();
        onProfileChange?.();
        // Picking an avatar while a photo is showing switches to the avatar.
        if (account.user?.pic && !busy) await run(() => account.setPicMode('avatar'));
      });
      return b;
    }));
  }

  function renderPhoto() {
    const u = account.user;
    $('#photo-in').hidden = !u;
    $('#photo-guest').hidden = !!u;
    if (!u) return;
    const hasAny = u.photo || !!u.providerPic;
    $('#photo-upload').textContent = u.photo ? 'CHANGE PHOTO' : 'UPLOAD PHOTO';
    $('#photo-remove').hidden = !u.photo;
    if (!busy) use.checked = hasAny && u.picMode !== 'avatar';
    use.disabled = !hasAny || busy;
    use.closest('label').hidden = !hasAny;
    $('#photo-upload').disabled = busy;
    $('#photo-remove').disabled = busy;
  }

  function renderAccount() {
    const u = account.user;
    const p = account.providers;
    $('#account-out').hidden = !!u;
    $('#account-in').hidden = !u;
    $('#signin-google').hidden = !p.google;
    $('#signin-facebook').hidden = !p.facebook;
    $('#signin-dev').hidden = !p.dev;
    $('#signin-none').hidden = account.anyProvider || !account.loaded;
    name.maxLength = u ? 20 : 14;
    if (u) {
      $('#account-avatar').replaceChildren(avatarEl({ pic: u.pic, avatar: prefs.avatar }, 'avatar big'));
      $('#account-name').textContent = u.name;
      $('#account-code').textContent = social.list?.code || u.friendCode || '';
    }
  }

  function render() {
    renderPreview();
    renderPhoto();
    renderAccount();
  }

  async function run(fn) {
    busy = true;
    renderPhoto();
    try {
      await fn();
    } catch (err) {
      toast(err.message || 'Something went wrong');
    } finally {
      busy = false;
      render();
    }
  }

  $('#photo-upload').addEventListener('click', () => { audio.play('tap'); file.click(); });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('Pick an image file');
    run(async () => {
      const blob = await squarePhoto(f).catch(() => { throw new Error("Couldn't read that image"); });
      await account.uploadPhoto(blob);
      toast('Photo updated');
    });
  });
  $('#photo-remove').addEventListener('click', () => {
    audio.play('tap');
    run(async () => {
      await account.removePhoto();
      toast('Photo removed');
    });
  });
  use.addEventListener('change', () => {
    audio.play('tap');
    const mode = use.checked ? 'auto' : 'avatar';
    run(() => account.setPicMode(mode));
  });

  let nameTimer = 0;
  name.addEventListener('input', () => {
    savePrefs({ name: name.value.trim().slice(0, account.user ? 20 : 14) });
    renderPreview();
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => onProfileChange?.(), account.user ? 600 : 0);
  });

  $('#signin-google').addEventListener('click', () => { audio.play('tap'); account.signIn('google'); });
  $('#signin-facebook').addEventListener('click', () => { audio.play('tap'); account.signIn('facebook'); });
  $('#signin-dev').addEventListener('click', async () => {
    audio.play('tap');
    const who = window.prompt('Test account name', prefs.name);
    if (!who) return;
    try {
      await account.devSignIn(who);
      toast(`Signed in as ${account.user.name}`);
    } catch {
      toast('Sign-in failed');
    }
  });
  $('#signout').addEventListener('click', async () => {
    audio.play('tap');
    await account.signOut();
    toast('Signed out');
  });
  account.on('change', () => {
    if (account.user) name.value = prefs.name;
    render();
    onProfileChange?.();
  });
  social.on('change', renderPreview);

  return {
    show() {
      name.value = prefs.name;
      renderAvatars();
      render();
    },
  };
}
