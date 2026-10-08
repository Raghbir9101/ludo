// Settings screen: sound, vibration and gameplay preferences. Name, avatar and account
// live on the Profile screen.
import { $ } from './dom.js';
import { prefs, savePrefs, prefersReducedMotion } from '../prefs.js';
import { audio } from '../audio.js';
import { motion } from '../anim.js';

export function applyPrefs() {
  audio.setVolume(prefs.volume);
  audio.setSfx(prefs.sfx);
  audio.setMusic(prefs.music);
  audio.setVibrate(prefs.vibrate);
  motion.reduced = prefersReducedMotion();
  document.body.classList.toggle('reduced', motion.reduced);
}

export function settingsScreen() {
  const vol = $('#set-volume');
  const bind = (id, key, after) => {
    const el = $(id);
    el.checked = !!prefs[key];
    el.addEventListener('change', () => {
      savePrefs({ [key]: el.checked });
      applyPrefs();
      after?.(el.checked);
      audio.play('tap');
    });
    return el;
  };

  vol.addEventListener('input', () => {
    savePrefs({ volume: Number(vol.value) / 100 });
    applyPrefs();
  });
  vol.addEventListener('change', () => audio.play('tap'));
  bind('#set-sfx', 'sfx');
  bind('#set-music', 'music', (on) => { if (on) audio.startMusic(); });
  bind('#set-vibrate', 'vibrate', (on) => { if (on) audio.vibrate(40); });
  bind('#set-automove', 'autoMove');
  const reduced = $('#set-reduced');
  reduced.checked = prefersReducedMotion();
  reduced.addEventListener('change', () => {
    savePrefs({ reducedMotion: reduced.checked });
    applyPrefs();
  });
  if (!('vibrate' in navigator)) $('#set-vibrate').closest('label').hidden = true;

  let installPrompt = null;
  const install = $('#set-install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    install.hidden = false;
  });
  window.addEventListener('appinstalled', () => { install.hidden = true; });
  install.addEventListener('click', async () => {
    audio.play('tap');
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    install.hidden = true;
  });

  return {
    show() {
      vol.value = String(Math.round(prefs.volume * 100));
      for (const [id, key] of [['#set-sfx', 'sfx'], ['#set-music', 'music'], ['#set-vibrate', 'vibrate'], ['#set-automove', 'autoMove']]) $(id).checked = !!prefs[key];
      reduced.checked = prefersReducedMotion();
    },
  };
}
