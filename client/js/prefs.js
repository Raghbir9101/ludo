// Persistent user preferences (localStorage).
const KEY = 'ludo.prefs.v1';

export const AVATARS = ['🦊', '🐼', '🐸', '🐯', '🐵', '🐰', '🐨', '🐙', '🦁', '🐧', '🦄', '🐢'];
export const BOT_AVATAR = '🤖';

const defaults = {
  name: '',
  avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
  volume: 0.8,
  sfx: true,
  music: true,
  vibrate: true,
  autoMove: true,
  reducedMotion: null, // null = follow the OS setting
  lastCount: 4,
  lastColor: 0,
  lastDifficulty: 'medium',
};

function load() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

export const prefs = load();

export function savePrefs(patch = {}) {
  Object.assign(prefs, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch { /* storage full or disabled */ }
}

export function displayName() {
  return prefs.name || 'Player';
}

export function prefersReducedMotion() {
  if (prefs.reducedMotion != null) return prefs.reducedMotion;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
