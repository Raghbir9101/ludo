// Online screens: create room, join room, lobby. Hands off to the game screen on start.
import { COLORS } from '/shared/rules.js';
import { buildBoard, rotateBoard, povSteps } from '../board/geometry.js';
import { net } from '../net.js';
import { OnlineGame } from '../state.js';
import { $, h, segmented, toast, announce, avatarEl, modal, closeModal } from './dom.js';
import { prefs, savePrefs, displayName, AVATARS } from '../prefs.js';
import { audio } from '../audio.js';
import { GAME_NAME } from '/shared/config.js';
import { account } from '../account.js';
import { social } from '../social.js';
import { inviteFriendsModal } from './friends.js';

export function initOnline({ go, goHome, startGame, screens }) {
  let room = null;
  let roomSeq = -1;
  let ctrl = null;
  let moving = -1;
  let pendingJoin = null;

  if (!prefs.name) savePrefs({ name: `Player${100 + Math.floor(Math.random() * 900)}` });

  const current = () => document.querySelector('.screen.active')?.id?.replace('scr-', '');

  // ---------- create ----------
  const cfg = { n: 4, teamMode: false, timer: 30, quickMode: 0 };
  const countSeg = segmented($('#create-count'), [4, 6, 8].map((v) => ({ value: v, label: String(v) })), cfg.n, (v) => { cfg.n = v; });
  const modeSeg = segmented($('#create-mode'), [{ value: false, label: 'Free-for-all' }, { value: true, label: 'Team' }], false, (v) => { cfg.teamMode = v; });
  segmented($('#create-timer'), [{ value: 15, label: '15s' }, { value: 30, label: '30s' }, { value: 0, label: 'Off' }], 30, (v) => { cfg.timer = v; });
  segmented($('#create-quick'), [{ value: 0, label: 'Classic' }, { value: 1, label: 'Quick: 1 home' }, { value: 2, label: 'Quick: 2 home' }], 0, (v) => { cfg.quickMode = v; });
  let connWarn = 0;
  const needServer = () => {
    if (net.ready) return;
    toast('Connecting to the game server...', 2500);
    clearTimeout(connWarn);
    connWarn = setTimeout(() => {
      if (net.ready) return;
      net.dropQueued(['create', 'join']);
      pendingJoin = null;
      toast("Can't reach the game server. Check your connection - Solo still works offline.", 4500);
    }, 5000);
  };

  // Name (and avatar, for guests without a photo) check before entering a room.
  function askName({ title, action }) {
    return new Promise((resolve) => {
      const max = account.user ? 20 : 14;
      let avatar = prefs.avatar;
      const input = h('input', { class: 'text-input', type: 'text', maxlength: String(max), autocomplete: 'nickname', enterkeyhint: 'go', 'aria-label': 'Your name', value: prefs.name || '' });
      const err = h('p', { class: 'name-err', hidden: true }, 'Enter a name with at least 2 letters.');
      const preview = () => avatarEl({ pic: account.user?.pic, avatar }, 'avatar big');
      let face = preview();
      const pics = account.user?.pic ? null : h('div', { class: 'avatars', role: 'radiogroup', 'aria-label': 'Avatar' }, AVATARS.map((a) => {
        const b = h('button', { type: 'button', class: 'avatar-opt', role: 'radio', 'aria-label': `Avatar ${a}`, 'aria-checked': String(a === avatar) }, a);
        b.addEventListener('click', () => {
          audio.play('tap');
          avatar = a;
          pics.querySelectorAll('.avatar-opt').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
          const next = preview();
          face.replaceWith(next);
          face = next;
        });
        return b;
      }));
      const body = h('div', { class: 'name-ask' }, face, h('label', { class: 'text-label' }, 'Your name', input), err, pics);
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      const submit = () => {
        const name = input.value.trim().slice(0, max);
        if (name.length < 2) {
          err.hidden = false;
          input.focus();
          return;
        }
        closeModal();
        const changed = name !== prefs.name || avatar !== prefs.avatar;
        savePrefs({ name, avatar });
        if (changed) {
          screens?.home?.render?.();
          if (net.ready) net.send('profile', { name, avatar });
        }
        finish(true);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      input.addEventListener('input', () => { err.hidden = true; });
      modal({
        title,
        body,
        actions: [
          { label: action, cls: 'c-green', keepOpen: true, onClick: submit },
          { label: 'CANCEL', cls: 'c-red', onClick: () => finish(false) },
        ],
        cancel: () => finish(false),
      });
      setTimeout(() => { input.focus(); input.select(); }, 60);
    });
  }

  $('#create-go').addEventListener('click', async () => {
    audio.play('tap');
    if (!account.user && !(await askName({ title: 'Your name', action: 'CREATE' }))) return;
    needServer();
    $('#create-go').disabled = true;
    setTimeout(() => { $('#create-go').disabled = false; }, 1500);
    net.send('create', {
      opts: {
        ...cfg,
        blockades: $('#create-blockades').checked,
        captureToEnterHome: $('#create-capture').checked,
        assist: $('#create-assist').checked,
        autoMove: $('#create-automove').checked,
      },
    });
  });

  // ---------- join ----------
  const codeInput = $('#join-code');
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    $('#join-error').hidden = true;
    $('#join-spectate').hidden = true;
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join-go').click(); });
  $('#join-go').addEventListener('click', async () => {
    audio.play('tap');
    const code = codeInput.value.trim();
    if (code.length !== 6) return showJoinError('Room codes have 6 letters and numbers.');
    if (!account.user && !(await askName({ title: 'Your name', action: 'JOIN' }))) return;
    needServer();
    pendingJoin = code;
    net.send('join', { code });
  });
  $('#join-spectate').addEventListener('click', () => {
    audio.play('tap');
    pendingJoin = codeInput.value.trim();
    net.send('join', { code: pendingJoin, spectate: true });
  });

  function showJoinError(msg, offerSpectate = false) {
    const el = $('#join-error');
    el.textContent = msg;
    el.hidden = false;
    $('#join-spectate').hidden = !offerSpectate;
    announce(msg, true);
  }

  // ---------- lobby ----------
  $('#lobby-leave').addEventListener('click', () => {
    audio.play('tap');
    net.send('leave');
    room = null;
    goHome();
  });
  $('#lobby-share').addEventListener('click', async () => {
    audio.play('tap');
    if (!room) return;
    const url = `${location.origin}/r/${room.code}`;
    const data = { title: GAME_NAME, text: `Join my ${GAME_NAME} game! Room code ${room.code}`, url };
    if (navigator.share) {
      try { await navigator.share(data); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied!');
    } catch {
      toast(url, 5000);
    }
  });
  $('#lobby-ready').addEventListener('click', () => {
    audio.play('tap');
    const me = room?.seats[room.you.seat];
    if (me) net.send('ready', { on: !me.ready });
  });
  $('#lobby-start').addEventListener('click', () => {
    audio.play('tap');
    net.send('start');
  });
  $('#lobby-fillbots').addEventListener('change', (e) => net.send('setFill', { on: e.target.checked }));
  $('#lobby-shuffle').addEventListener('click', () => {
    audio.play('tap');
    moving = -1;
    net.send('shuffleSeats');
  });
  $('#lobby-invite').addEventListener('click', () => {
    audio.play('tap');
    inviteFriendsModal();
  });
  social.on('change', () => { if (room && current() === 'lobby') renderLobby(); });
  account.on('change', () => { if (room && current() === 'lobby') renderLobby(); });
  const diffSeg = segmented($('#lobby-diff'), [
    { value: 'easy', label: 'Easy bots' }, { value: 'medium', label: 'Medium bots' }, { value: 'hard', label: 'Hard bots' },
  ], 'medium', (v) => net.send('setDifficulty', { d: v }));

  function renderLobby() {
    if (!room) return;
    const r = room;
    const you = r.you;
    $('#lobby-code').textContent = r.code;
    const parts = [`${r.opts.n} players`, r.opts.teamMode ? 'Teams' : 'Free-for-all', r.opts.timer ? `${r.opts.timer}s timer` : 'No timer'];
    if (r.opts.quickMode) parts.push(`Quick (${r.opts.quickMode} home)`);
    if (r.opts.blockades) parts.push('Blockades');
    if (r.opts.captureToEnterHome) parts.push('Capture to enter home');
    if (r.opts.teamMode) parts.push(r.opts.assist ? 'Assist on' : 'Assist off');
    if (r.spectators) parts.push(`${r.spectators} watching`);
    $('#lobby-rules').textContent = parts.join(' · ');

    const b = rotateBoard(buildBoard(r.opts.n), povSteps(r.opts.n, you.seat));
    const R = Math.max(...b.yards.map((y) => Math.hypot(y.center.x, y.center.y)));
    const ring = $('#lobby-seats');
    const teams = r.teams || r.seats.map((_, i) => i % 2);
    const me = account.user?.id;
    if (moving >= r.seats.length) moving = -1;
    ring.replaceChildren(...r.seats.map((s, i) => {
      const y = b.yards[i].center;
      const c = s.kind !== 'empty' ? COLORS[s.color] : null;
      const role = s.kind === 'empty' ? 'Empty' : s.kind === 'bot' ? 'Bot' : s.host ? 'Host' : !s.connected ? 'Offline' : '';
      const tag = [role, r.opts.teamMode ? `Team ${'AB'[teams[i]]}` : ''].filter(Boolean).join(' · ');
      const tools = [];
      const tool = (label, fn, aria) => tools.push(h('button', { type: 'button', 'aria-label': aria || null, onclick: () => { audio.play('tap'); fn(); } }, label));
      const name = s.name || `seat ${i + 1}`;
      if (you.host && r.phase === 'lobby') {
        if (moving >= 0 && moving !== i) {
          tool('Here', () => { net.send('moveSeat', { from: moving, to: i }); moving = -1; }, `Swap ${r.seats[moving].name || 'seat'} with ${name}`);
        } else if (moving === i) {
          tool('Cancel', () => { moving = -1; renderLobby(); });
        } else {
          if (s.kind !== 'empty') tool('Move', () => { moving = i; renderLobby(); }, `Move ${name}`);
          if (s.kind === 'human' && i !== you.seat) {
            tool('Kick', () => net.send('kick', { seat: i }), `Kick ${s.name}`);
            if (s.connected) tool('Host', () => net.send('makeHost', { seat: i }), `Make ${s.name} the host`);
          }
          if (s.kind === 'empty') tool('+ Bot', () => net.send('setBot', { seat: i, on: true }));
          if (s.kind === 'bot') tool('Remove', () => net.send('setBot', { seat: i, on: false }), `Remove ${s.name}`);
          if (r.opts.teamMode) tool(`→ ${'AB'[1 - teams[i]]}`, () => net.send('setTeam', { seat: i, team: 1 - teams[i] }), `Put ${name} on team ${'AB'[1 - teams[i]]}`);
        }
      }
      if (me && s.uid && s.uid !== me && moving < 0) {
        const rel = social.relation(s.uid);
        if (!rel) tool('+ Friend', () => net.send('friendAdd', { id: s.uid }), `Add ${s.name} as a friend`);
        else if (rel === 'received') tool('Accept', () => net.send('friendRespond', { id: s.uid, accept: true }), `Accept ${s.name}'s friend request`);
      }
      const el = h('div', {
        class: `seat${s.kind === 'empty' ? ' empty' : ''}${i === you.seat ? ' me' : ''}${moving === i ? ' moving' : ''}${r.opts.teamMode ? ` team-${'ab'[teams[i]]}` : ''}`,
        role: 'group',
        'aria-label': s.kind === 'empty' ? `Seat ${i + 1}, empty` : `Seat ${i + 1}, ${s.name}${tag ? ', ' + tag : ''}${s.ready ? ', ready' : ''}`,
        style: {
          left: `${50 + (y.x / R) * 37}%`, top: `${50 + (y.y / R) * 37}%`,
          '--seat-c': c ? c.hex : '#ddd', '--seat-d': c ? c.dark : '#ccc',
        },
      },
      s.kind === 'empty' ? h('span', { class: 'avatar' }, '＋') : avatarEl(s, 'avatar', c ? { background: c.light } : null),
      h('span', { class: 'nm' }, s.kind === 'empty' ? 'Open' : s.name + (i === you.seat ? ' (you)' : '')),
      tag ? h('span', { class: 'tag' }, tag) : null,
      s.ready && s.kind === 'human' ? h('span', { class: 'ready' }, '✓') : null,
      tools.length ? h('div', { class: 'seat-tools' }, tools) : null);
      return el;
    }));

    const taken = new Set(r.seats.filter((s, i) => s.kind !== 'empty' && i !== you.seat).map((s) => s.color));
    const mine = r.seats[you.seat];
    $('#lobby-colors').setAttribute('role', 'radiogroup');
    $('#lobby-colors').replaceChildren(...COLORS.map((c) => {
      const btn = h('button', {
        type: 'button', class: 'swatch', role: 'radio', 'aria-label': c.name + (taken.has(c.id) ? ' (taken)' : ''),
        'aria-checked': String(mine?.color === c.id), disabled: taken.has(c.id) ? true : null, style: { background: c.hex },
      });
      btn.addEventListener('click', () => { audio.play('tap'); net.send('setColor', { color: c.id }); });
      return btn;
    }));

    $('#lobby-host').hidden = !you.host;
    $('#lobby-invite').hidden = !account.user || r.phase !== 'lobby';
    if (account.user && !social.list) net.send('friends');
    $('#lobby-fillbots').checked = r.fillBots;
    diffSeg.set(r.difficulty);
    const humans = r.seats.filter((s) => s.kind === 'human');
    const notReady = humans.filter((s) => !s.ready && !s.host);
    $('#lobby-ready').hidden = you.host;
    $('#lobby-ready').textContent = mine?.ready ? 'NOT READY' : 'READY';
    $('#lobby-ready').classList.toggle('c-green', !mine?.ready);
    $('#lobby-ready').classList.toggle('c-orange', !!mine?.ready);
    $('#lobby-start').hidden = !you.host;
    const canStart = humans.length >= 2 && notReady.length === 0;
    $('#lobby-start').disabled = !canStart;
    $('#lobby-hint').textContent = humans.length < 2
      ? 'Waiting for at least one more player. Share the code!'
      : notReady.length ? `Waiting for ${notReady.map((s) => s.name).join(', ')} to be ready`
        : you.host ? 'Everyone is ready!' : 'Waiting for the host to start';
  }

  // ---------- server messages ----------
  net.on('room', (m) => {
    if (room && room.code === m.room.code && m.seq <= roomSeq) return;
    const fresh = !room || room.code !== m.room.code;
    room = m.room;
    roomSeq = m.seq;
    localStorage.setItem('ludo.room', room.code);
    pendingJoin = null;
    if (ctrl) { ctrl.dispose(); ctrl = null; }
    if (current() !== 'lobby') {
      go('lobby', { replace: ['create', 'join', 'results', 'game', 'lobby'].includes(current()) });
      if (location.pathname !== '/') history.replaceState({}, '', '/');
    }
    if (fresh) announce(`Joined room ${room.code}.`);
    renderLobby();
  });

  net.on('game', (m) => {
    if (ctrl && ctrl.code === m.code) return;
    room = null;
    pendingJoin = null;
    localStorage.setItem('ludo.room', m.code);
    if (location.pathname !== '/') history.replaceState({}, '', '/');
    ctrl = new OnlineGame(net, m);
    ctrl.leave = () => {
      net.send('leave');
      ctrl?.dispose();
      ctrl = null;
      localStorage.removeItem('ludo.room');
    };
    ctrl.here = () => {
      const me = [...ctrl.mySeats][0];
      if (me != null && ctrl.players[me]?.afk) net.send('here');
    };
    startGame(ctrl, `Room ${m.code}`);
  });

  net.on('error', (m) => {
    if (pendingJoin || current() === 'join') {
      if (m.code === 'notFound') return showJoinError('Room not found. Check the code and try again.');
      if (m.code === 'full') return showJoinError('That room is full.');
      if (m.code === 'started') return showJoinError('That game has already started. You can watch it instead.', true);
      if (m.code === 'kicked') return showJoinError('You were removed from that room.');
    }
    if (m.code === 'notInRoom' && current() === 'results') { goHome(); return toast('That room has closed.'); }
    if (['notYourTurn', 'badAction', 'illegalMove'].includes(m.code)) return;
    if (/^(friend|invite|login)/.test(m.code || '')) return;
    if (m.msg) toast(m.msg);
  });

  net.on('left', (m) => {
    localStorage.removeItem('ludo.room');
    const wasIn = !!room || !!ctrl;
    room = null;
    if (ctrl) { ctrl.dispose(); ctrl = null; }
    if (m.reason === 'kicked') toast('The host removed you from the room.');
    else if (m.reason === 'closed') toast('The room was closed.');
    else if (m.reason === 'elsewhere') toast('This game is now open on another tab or device.', 3500);
    if (m.reason !== 'left' && wasIn) goHome();
  });

  net.on('welcome', (m) => {
    if (m.room) return;
    localStorage.removeItem('ludo.room');
    // Back online but the server no longer holds our seat (held too long as a guest, or the
    // room closed): don't leave the player on a dead lobby or game.
    if (room || ctrl) {
      room = null;
      if (ctrl) { ctrl.dispose(); ctrl = null; }
      goHome();
      toast('You were away too long and lost your seat in that room.', 4000);
    }
  });

  // A banner while the connection is down in a room or game; a short note when it's back.
  const banner = $('#net-banner');
  let bannerTimer = 0;
  net.on('status', (s) => {
    clearTimeout(bannerTimer);
    if (s === 'online') {
      if (!banner.hidden) toast('Reconnected', 1500);
      banner.hidden = true;
      if (ctrl) ctrl.resync();
    } else if (room || ctrl) {
      bannerTimer = setTimeout(() => { banner.hidden = false; }, 700);
    }
  });

  return {
    openCreate({ n, team } = {}) {
      net.connect();
      if (n) { cfg.n = n; countSeg.set(n); }
      if (team != null) { cfg.teamMode = team; modeSeg.set(team); }
      go('create');
    },
    openJoin() {
      net.connect();
      $('#join-error').hidden = true;
      $('#join-spectate').hidden = true;
      go('join');
      setTimeout(() => codeInput.focus(), 60);
    },
    async joinByLink(code) {
      net.connect();
      codeInput.value = code;
      $('#join-error').hidden = true;
      $('#join-spectate').hidden = true;
      go('join');
      if (location.pathname !== '/') history.replaceState({}, '', '/');
      if (!(await askName({ title: `Join room ${code}`, action: 'JOIN' }))) return;
      pendingJoin = code;
      net.send('join', { code });
    },
    tryResume() {
      net.connect();
    },
    backToLobby() {
      net.send('backToLobby');
    },
    profileChanged() {
      if (net.ready) net.send('profile', { name: displayName(), avatar: prefs.avatar });
    },
    inLobby() {
      return !!room && room.phase === 'lobby';
    },
  };
}
