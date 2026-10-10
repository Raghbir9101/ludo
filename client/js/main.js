// Boot sequence and screen router.
import { GAME_NAME } from '/shared/config.js';
import { $, $$, toast, closeModal, modalKey } from './ui/dom.js';
import { paintBackdrop, drawLogo, drawTileIcon, colorTitle } from './ui/theme.js';
import { audio } from './audio.js';
import { applyPrefs, settingsScreen } from './ui/settings.js';
import { profileScreen } from './ui/profile.js';
import { homeScreen } from './ui/home.js';
import { setupScreen } from './ui/setup.js';
import { GameScreen } from './ui/game.js';
import { showResults } from './ui/results.js';
import { LocalGame } from './local.js';
import { account } from './account.js';
import { net } from './net.js';
import { prefs, displayName } from './prefs.js';
import { friendsScreen, initSocial } from './ui/friends.js';

const screens = {};
let current = 'splash';
const stack = [];

function setActive(name, backAnim) {
  const prev = $(`#scr-${current}`);
  const next = $(`#scr-${name}`);
  if (!next) return;
  if ((current === 'game' || current === 'results') && name !== 'game' && name !== 'results') {
    game?.close();
    audio.stopMusic();
  }
  if (name === 'results') audio.stopMusic();
  next.classList.toggle('back-anim', !!backAnim);
  prev?.classList.remove('active');
  next.classList.add('active');
  current = name;
  screens[name]?.show?.();
  requestAnimationFrame(() => {
    const focusTarget = next.querySelector('[data-autofocus]') || next.querySelector('h2, .btn, button, input');
    if (focusTarget && name !== 'game') {
      if (!focusTarget.hasAttribute('tabindex') && /^H\d$/.test(focusTarget.tagName)) focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus({ preventScroll: true });
    }
  });
}

export function go(name, { replace = false } = {}) {
  if (name === current) {
    screens[name]?.show?.();
    return;
  }
  if (!replace && current !== 'splash') stack.push(current);
  history.pushState({ screen: name }, '');
  setActive(name);
}

export function goBack() {
  const prev = stack.pop() || 'home';
  setActive(prev, true);
}

export function goHome() {
  stack.length = 0;
  setActive('home', true);
  if (location.pathname !== '/') history.replaceState({}, '', '/');
}

// Modal keys first (capture phase), then Escape acts as Back on menu screens.
window.addEventListener('keydown', (e) => {
  if (modalKey(e)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.key === 'Escape' && current !== 'game') $(`#scr-${current} [data-back]`)?.click();
}, true);

window.addEventListener('popstate', () => {
  if (current === 'game') {
    history.pushState({ screen: 'game' }, '');
    $('#game-menu').click();
    return;
  }
  if (current !== 'home' && current !== 'splash') goBack();
});

// ---------- online (loaded on demand) ----------
let onlinePromise = null;
let onlineApi = null;
export function online() {
  if (!onlinePromise) {
    onlinePromise = import('./ui/lobby.js').then((m) => (onlineApi = m.initOnline({ go, goBack, goHome, startGame, screens })));
  }
  return onlinePromise;
}

// ---------- game ----------
let game;
let lastLocalConfig = null;

function startGame(ctrl, title) {
  closeModal();
  go('game', { replace: current === 'lobby' || current === 'results' });
  game.open(ctrl, { title });
  ctrl.start?.();
}

function startLocal(cfg) {
  lastLocalConfig = cfg;
  const ctrl = new LocalGame(cfg);
  startGame(ctrl, cfg.title);
}

async function boot() {
  document.title = GAME_NAME;
  $$('.app-name').forEach((el) => { el.textContent = GAME_NAME; });
  const bar = $('#scr-splash .bar');
  const pb = $('#scr-splash .progress');
  const setProgress = (p) => {
    bar.style.width = `${Math.round(p * 100)}%`;
    pb.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  };
  const t0 = performance.now();
  $$('.title .app-name').forEach((el) => colorTitle(el, GAME_NAME));
  applyPrefs();
  paintBackdrop();
  $$('.logo-canvas').forEach((c) => drawLogo(c));
  setProgress(0.2);
  try {
    await Promise.race([document.fonts.load('700 20px Fredoka'), new Promise((r) => setTimeout(r, 1500))]);
  } catch { /* font failed; fallbacks are fine */ }
  $$('.logo-canvas').forEach((c) => drawLogo(c));
  $$('.tile-art').forEach((c) => drawTileIcon(c, c.dataset.art));
  setProgress(0.6);

  screens.home = homeScreen();
  screens.settings = settingsScreen();
  screens.profile = profileScreen({
    onProfileChange: () => {
      screens.home.render();
      if (net.ready) net.send('profile', { name: displayName(), avatar: prefs.avatar });
    },
  });
  screens.friends = friendsScreen({ online, inLobby: () => !!onlineApi?.inLobby() });
  initSocial({ online, isPlaying: () => current === 'game' });
  // The server may put us back into a room on any (re)connect, e.g. a signed-in player on a
  // new device. Make sure the lobby/game handlers exist, then ask for the room again.
  net.on('welcome', (m) => {
    if (m.room && !onlineApi) online().then(() => net.send('resync')).catch(() => {});
  });
  const login = new URLSearchParams(location.search).get('login');
  account.load().then((u) => {
    if (login === 'ok' && u) toast(`Signed in as ${u.name}`);
    if (u) online().then((o) => o.tryResume()).catch(() => {});
  });
  if (login === 'failed') toast('Sign-in was cancelled or failed. Please try again.', 3500);
  if (login) history.replaceState({}, '', location.pathname);
  screens.setup = setupScreen({
    onStart: startLocal,
    onCreateTeamRoom: async ({ n }) => {
      const o = await online();
      o.openCreate({ n, team: true });
    },
  });
  game = new GameScreen({
    onExit: () => goHome(),
    onGameOver: (ctrl, ranks) => {
      showResults(ctrl, ranks);
      go('results', { replace: true });
      $('#results-again').onclick = () => {
        audio.play('tap');
        if (ctrl.kind === 'local') {
          startGame(ctrl.rematch(), lastLocalConfig?.title);
        } else {
          online().then((o) => o.backToLobby());
        }
      };
      $('#results-home').onclick = () => {
        audio.play('tap');
        if (ctrl.kind !== 'local') ctrl.leave();
        goHome();
      };
    },
  });
  screens.game = { show() {} };
  if (new URLSearchParams(location.search).has('debug')) window.__ludo = { game, go, online };
  setProgress(0.85);

  // Navigation wiring.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go],[data-mode],[data-back],#profile-chip,#friends-btn');
    audio.unlock();
    if (!t) return;
    audio.play('tap');
    if (t.id === 'profile-chip') return go('profile');
    if (t.id === 'friends-btn') return go('friends');
    if (t.dataset.back != null) return goBack();
    if (t.dataset.mode) {
      go('setup');
      screens.setup.show(t.dataset.mode);
      return;
    }
    const target = t.dataset.go;
    if (target === 'create') online().then((o) => o.openCreate({}));
    else if (target === 'join') online().then((o) => o.openJoin());
    else go(target);
  });
  // Any first gesture unlocks audio.
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const wait = Math.max(0, 450 - (performance.now() - t0));
  setProgress(1);
  await new Promise((r) => setTimeout(r, wait));
  // Home-screen shortcuts (manifest "shortcuts") open a mode directly.
  const play = new URLSearchParams(location.search).get('play');
  history.replaceState({ screen: 'home' }, '', location.search ? location.pathname : undefined);
  setActive('home');

  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{6})\/?$/);
  if (m) {
    const o = await online();
    o.joinByLink(m[1].toUpperCase());
  } else if (play === 'solo') {
    go('setup');
    screens.setup.show('solo');
  } else if (play === 'join') {
    online().then((o) => o.openJoin());
  } else {
    // Rejoin a game in progress after a reload, if the server still holds our seat.
    const sess = localStorage.getItem('ludo.session');
    if (sess && localStorage.getItem('ludo.room')) online().then((o) => o.tryResume()).catch(() => {});
  }
}

boot().catch((err) => {
  console.error(err);
  toast('Something went wrong while loading. Please refresh.');
});
