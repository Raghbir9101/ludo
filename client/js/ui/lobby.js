// Online screens: create room, join room, lobby. Hands off to the game screen on start.
import { COLORS, TEAM_COUNTS, TEAM_NAMES, teamCountFor, teamName, teamSplitLabel } from '/shared/rules.js';
import { net } from '../net.js';
import { motion } from '../anim.js';
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
  let pendingJoin = null;

  if (!prefs.name) savePrefs({ name: `Player${100 + Math.floor(Math.random() * 900)}` });

  const current = () => document.querySelector('.screen.active')?.id?.replace('scr-', '');

  // ---------- create ----------
  const cfg = { n: 4, teamMode: false, teamCount: 2, timer: 30, quickMode: 0 };
  const refreshTeamSplit = () => {
    const wrap = $('#create-teams');
    const options = TEAM_COUNTS[cfg.n] || [2];
    wrap.hidden = !cfg.teamMode || options.length < 2;
    cfg.teamCount = teamCountFor(cfg.n, cfg.teamCount);
    if (wrap.hidden) return;
    segmented(wrap, options.map((c) => ({ value: c, label: teamSplitLabel(cfg.n, c) })), cfg.teamCount, (v) => { cfg.teamCount = v; });
  };
  const countSeg = segmented($('#create-count'), [4, 6, 8].map((v) => ({ value: v, label: String(v) })), cfg.n, (v) => { cfg.n = v; refreshTeamSplit(); });
  const modeSeg = segmented($('#create-mode'), [{ value: false, label: 'Free-for-all' }, { value: true, label: 'Team' }], false, (v) => { cfg.teamMode = v; refreshTeamSplit(); });
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
  $('#lobby-copy').addEventListener('click', async () => {
    audio.play('tap');
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      toast(`Room code ${room.code} copied`);
    } catch {
      toast(`Room code: ${room.code}`, 4000);
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

  // ---------- seats: cards, tap menu, drag and drop ----------
  const board = $('#lobby-seats');
  const scroller = $('#lobby-panel');
  const coarse = matchMedia('(pointer: coarse)');
  let drag = null;
  let renderLater = false;
  let suppressClickUntil = 0;
  let landing = null;

  const teamCount = () => room.opts.teamCount || 2;
  const teamOf = (i) => (room.teams ? room.teams[i] : i % teamCount());
  const inLobby = () => room?.phase === 'lobby' && !room.you.spectator && room.you.seat >= 0;
  const canDrag = (i) => inLobby() && (room.you.host ? room.seats[i].kind !== 'empty' : i === room.you.seat);
  const canDrop = (from, to) => from !== to && (room.you.host || room.seats[to].kind === 'empty');
  const seatKey = (s) => (s.kind === 'empty' ? null : `${s.kind}:${s.uid || s.name}`);
  const seatLabel = (s, i) => (s.kind === 'empty' ? `Seat ${i + 1}` : s.name);

  function seatStatus(s, i) {
    if (s.kind === 'empty') return [inLobby() && !room.you.host ? 'Tap to sit' : '', 'st-open'];
    const mine = i === room.you.seat ? 'You · ' : '';
    if (s.kind === 'bot') return ['Bot', 'st-bot'];
    if (!s.connected) return [`${mine}Offline`, 'st-off'];
    if (s.host) return [`${mine}Host`, 'st-host'];
    return s.ready ? [`${mine}Ready ✓`, 'st-ready'] : [`${mine}Not ready`, 'st-wait'];
  }

  function seatActions(i) {
    const r = room;
    const you = r.you;
    const s = r.seats[i];
    const acts = [];
    const add = (label, cls, fn) => acts.push({ label, cls, onClick: fn });
    if (inLobby() && you.host) {
      if (s.kind === 'empty') {
        add('ADD A BOT', 'c-green', () => net.send('setBot', { seat: i, on: true }));
        add('SIT HERE', 'c-blue', () => net.send('moveSeat', { from: you.seat, to: i }));
      } else {
        add(i === you.seat ? 'MOVE TO ANOTHER SEAT' : 'MOVE / SWAP SEAT', 'c-blue', () => pickSeat(i));
        if (r.opts.teamMode) {
          for (let t = 0; t < teamCount(); t++) {
            if (t !== teamOf(i)) add(`SWITCH TO ${teamName(t).toUpperCase()}`, 'c-blue', () => net.send('setTeam', { seat: i, team: t }));
          }
        }
        if (s.kind === 'human' && i !== you.seat && s.connected) add('MAKE HOST', 'c-yellow', () => net.send('makeHost', { seat: i }));
        if (s.kind === 'bot') add('REMOVE BOT', 'c-red', () => net.send('setBot', { seat: i, on: false }));
        if (s.kind === 'human' && i !== you.seat) add('REMOVE FROM ROOM', 'c-red', () => confirmKick(i));
      }
    } else if (inLobby()) {
      if (s.kind === 'empty') add('SIT HERE', 'c-green', () => net.send('moveSeat', { from: you.seat, to: i }));
      else if (i === you.seat && r.seats.some((x) => x.kind === 'empty')) add('MOVE TO ANOTHER SEAT', 'c-blue', () => pickSeat(i));
    }
    const me = account.user?.id;
    if (me && s.uid && s.uid !== me) {
      const rel = social.relation(s.uid);
      if (!rel) add('ADD FRIEND', 'c-purple', () => net.send('friendAdd', { id: s.uid }));
      else if (rel === 'received') add('ACCEPT FRIEND REQUEST', 'c-purple', () => net.send('friendRespond', { id: s.uid, accept: true }));
    }
    return acts;
  }

  function openSeat(i) {
    if (!room) return;
    const s = room.seats[i];
    const acts = seatActions(i);
    if (!acts.length) return;
    audio.play('tap');
    // An open seat for a non-host has just one thing to do: sit there.
    if (s.kind === 'empty' && !room.you.host) return acts[0].onClick();
    const [status] = seatStatus(s, i);
    const team = room.opts.teamMode ? ` · ${teamName(teamOf(i))}` : '';
    modal({
      title: s.kind === 'empty' ? `Seat ${i + 1}` : s.name,
      body: `${s.kind === 'empty' ? 'Open seat' : status}${team}`,
      actions: [...acts, { label: 'CLOSE', cls: 'c-blue' }],
    });
  }

  function pickSeat(from) {
    if (!room) return;
    const s = room.seats[from];
    const targets = room.seats.map((_, j) => j).filter((j) => canDrop(from, j));
    if (!targets.length) return toast('There is no other seat to move to.');
    modal({
      title: `Move ${s.name}`,
      body: 'Pick a seat. Taken seats are swapped.',
      actions: [
        ...targets.map((j) => {
          const t = room.seats[j];
          const team = room.opts.teamMode ? ` (${teamName(teamOf(j)).toUpperCase()})` : '';
          return {
            label: t.kind === 'empty' ? `SEAT ${j + 1}: OPEN${team}` : `SWAP WITH ${t.name.toUpperCase()}${team}`,
            cls: t.kind === 'empty' ? 'c-green' : 'c-blue',
            onClick: () => net.send('moveSeat', { from, to: j }),
          };
        }),
        { label: 'CANCEL', cls: 'c-red' },
      ],
    });
  }

  function confirmKick(i) {
    const s = room?.seats[i];
    if (!s) return;
    modal({
      title: `Remove ${s.name}?`,
      body: 'They will not be able to rejoin this room.',
      actions: [
        { label: 'REMOVE', cls: 'c-red', onClick: () => net.send('kick', { seat: i }) },
        { label: 'CANCEL', cls: 'c-blue' },
      ],
    });
  }

  function seatCard(i) {
    const r = room;
    const s = r.seats[i];
    const c = s.kind !== 'empty' ? COLORS[s.color] : null;
    const [status, st] = seatStatus(s, i);
    const acts = seatActions(i).length > 0;
    const draggable = canDrag(i);
    const name = s.kind === 'empty' ? 'Open' : s.name;
    const addBot = s.kind === 'empty' && inLobby() && r.you.host
      ? h('button', {
        type: 'button', class: 'sc-bot', 'aria-label': `Add a bot to seat ${i + 1}`,
        onclick: (e) => { e.stopPropagation(); audio.play('tap'); net.send('setBot', { seat: i, on: true }); },
      }, '+ BOT')
      : null;
    return h('div', {
      class: `seat-card${s.kind === 'empty' ? ' empty' : ''}${i === r.you.seat ? ' me' : ''}${acts ? ' tappable' : ''}`,
      'data-seat': String(i),
      'data-key': seatKey(s),
      'data-drag': draggable ? '' : null,
      role: acts ? 'button' : 'group',
      tabindex: acts ? '0' : null,
      'aria-label': `${seatLabel(s, i)}${i === r.you.seat ? ' (you)' : ''}: ${s.kind === 'empty' ? 'open seat' : status}${r.opts.teamMode ? `, ${teamName(teamOf(i))}` : ''}`,
      style: c ? { '--seat-c': c.hex, '--seat-d': c.dark } : null,
    },
    s.kind === 'empty' ? h('span', { class: 'avatar sc-av' }, '+') : avatarEl(s, 'avatar sc-av', { background: c.light }),
    h('span', { class: 'sc-info' },
      h('span', { class: 'nm' }, name),
      status ? h('span', { class: `sc-pill ${st}` }, status) : null),
    addBot || (draggable ? h('span', { class: 'sc-grip', 'aria-hidden': 'true' }) : acts ? h('span', { class: 'sc-more', 'aria-hidden': 'true' }, '⋯') : null));
  }

  function renderSeats() {
    const r = room;
    const before = new Map();
    board.querySelectorAll('.seat-card[data-key]').forEach((el) => before.set(el.dataset.key, el.getBoundingClientRect()));
    if (landing) before.set(landing.key, landing.rect);
    landing = null;
    if (r.opts.teamMode) {
      const tc = teamCount();
      board.className = `seat-board teams tc-${tc}`;
      board.replaceChildren(...Array.from({ length: tc }, (_, t) => {
        const seats = r.seats.map((_, i) => i).filter((i) => teamOf(i) === t);
        const filled = seats.filter((i) => r.seats[i].kind !== 'empty').length;
        return h('div', { class: `team-col team-${'abcd'[t]}`, 'data-team': String(t), role: 'group', 'aria-label': teamName(t) },
          h('div', { class: 'team-head' }, h('span', {}, teamName(t).toUpperCase()), h('small', {}, `${filled}/${seats.length}`)),
          ...seats.map(seatCard));
      }));
    } else {
      board.className = 'seat-board grid';
      board.replaceChildren(...r.seats.map((_, i) => seatCard(i)));
    }
    if (!before.size || motion.reduced) return;
    // Cards that changed place slide from where they were.
    board.querySelectorAll('.seat-card[data-key]').forEach((el) => {
      const a = before.get(el.dataset.key);
      if (!a) return;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) + Math.abs(dy) < 2) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 340, easing: 'cubic-bezier(.2,.9,.3,1.15)' });
    });
  }

  board.addEventListener('click', (e) => {
    if (performance.now() < suppressClickUntil) return;
    const card = e.target.closest('.seat-card.tappable');
    if (card && !e.target.closest('button')) openSeat(+card.dataset.seat);
  });
  board.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.seat-card.tappable');
    if (!card || e.target !== card) return;
    e.preventDefault();
    openSeat(+card.dataset.seat);
  });

  // Pointer drag: the mouse drags straight away; touch needs a short hold (or the grip) so
  // the list still scrolls normally.
  board.addEventListener('pointerdown', (e) => {
    if (drag || e.button > 0 || !room) return;
    const card = e.target.closest('.seat-card[data-drag]');
    if (!card || e.target.closest('button')) return;
    const grip = !!e.target.closest('.sc-grip');
    drag = {
      id: e.pointerId, from: +card.dataset.seat, card, on: false, over: null,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      hold: e.pointerType !== 'mouse' && !grip, timer: 0, raf: 0,
    };
    if (drag.hold) {
      card.classList.add('pressing');
      drag.timer = setTimeout(() => { if (drag && !drag.on) beginDrag(); }, 280);
    }
  });
  addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.on) {
      if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < 8) return;
      if (drag.hold) return dropDrag(false);
      beginDrag();
    }
    trackDrag();
  });
  addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) dropDrag(true); });
  addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) dropDrag(false); });
  document.addEventListener('touchmove', (e) => { if (drag?.on) e.preventDefault(); }, { passive: false });
  board.addEventListener('contextmenu', (e) => { if (drag) e.preventDefault(); });

  function beginDrag() {
    const d = drag;
    clearTimeout(d.timer);
    d.card.classList.remove('pressing');
    d.on = true;
    const rect = d.card.getBoundingClientRect();
    d.dx = d.x0 - rect.left;
    d.dy = d.y0 - rect.top;
    d.ghost = d.card.cloneNode(true);
    d.ghost.classList.add('seat-ghost');
    d.ghost.removeAttribute('tabindex');
    d.ghost.setAttribute('aria-hidden', 'true');
    d.ghost.style.width = `${rect.width}px`;
    d.ghost.style.height = `${rect.height}px`;
    document.body.append(d.ghost);
    d.card.classList.add('drag-src');
    board.classList.add('dragging');
    board.querySelectorAll('.seat-card').forEach((el) => { if (canDrop(d.from, +el.dataset.seat)) el.classList.add('drop-ok'); });
    if (room.opts.teamMode && room.you.host) {
      board.querySelectorAll('.team-col').forEach((el) => { if (+el.dataset.team !== teamOf(d.from)) el.classList.add('drop-ok'); });
    }
    navigator.vibrate?.(12);
    audio.play('tap');
    trackDrag();
    d.raf = requestAnimationFrame(autoScroll);
  }

  function trackDrag() {
    const d = drag;
    d.ghost.style.transform = `translate(${d.x - d.dx}px, ${d.y - d.dy}px) rotate(-3deg) scale(1.06)`;
    const t = document.elementFromPoint(d.x, d.y)?.closest('.seat-card.drop-ok, .team-col.drop-ok') || null;
    if (t === d.over) return;
    d.over?.classList.remove('drop-over');
    t?.classList.add('drop-over');
    if (t) navigator.vibrate?.(6);
    d.over = t;
  }

  function autoScroll() {
    const d = drag;
    if (!d?.on) return;
    const r = scroller.getBoundingClientRect();
    const bar = scroller.querySelector('.lobby-actions')?.offsetHeight || 0;
    const top = r.top + 56;
    const bottom = r.bottom - bar - 24;
    const v = d.y < top ? (d.y - top) / 4 : d.y > bottom ? (d.y - bottom) / 4 : 0;
    if (v) {
      scroller.scrollTop += Math.max(-16, Math.min(16, v));
      trackDrag();
    }
    d.raf = requestAnimationFrame(autoScroll);
  }

  function dropDrag(drop) {
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    d.card.classList.remove('pressing');
    if (!d.on) return;
    cancelAnimationFrame(d.raf);
    suppressClickUntil = performance.now() + 400;
    const t = drop && room ? d.over : null;
    board.classList.remove('dragging');
    board.querySelectorAll('.drop-ok, .drop-over').forEach((el) => el.classList.remove('drop-ok', 'drop-over'));
    if (t) {
      landing = { key: d.card.dataset.key, rect: d.ghost.getBoundingClientRect() };
      d.ghost.remove();
      if (t.classList.contains('team-col')) net.send('setTeam', { seat: d.from, team: +t.dataset.team });
      else net.send('moveSeat', { from: d.from, to: +t.dataset.seat });
      // If the server says no, put the card back.
      setTimeout(() => { if (d.card.isConnected) { d.card.classList.remove('drag-src'); landing = null; } }, 900);
    } else {
      const home = d.card.getBoundingClientRect();
      const back = d.ghost.animate(
        [{ transform: d.ghost.style.transform }, { transform: `translate(${home.left}px, ${home.top}px)` }],
        { duration: motion.reduced ? 1 : 200, easing: 'ease-out' },
      );
      back.onfinish = () => { d.ghost.remove(); d.card.classList.remove('drag-src'); };
    }
    if (renderLater) {
      renderLater = false;
      renderLobby();
    }
  }

  function renderLobby() {
    if (!room) return;
    if (drag?.on) { renderLater = true; return; }
    const r = room;
    const you = r.you;
    $('#lobby-code').textContent = r.code;
    const filled = r.seats.filter((s) => s.kind !== 'empty').length;
    $('#lobby-count').textContent = `${filled}/${r.seats.length}`;
    $('#lobby-count').setAttribute('aria-label', `${filled} of ${r.seats.length} seats filled`);
    const parts = [r.opts.teamMode ? (teamCount() > 2 ? `${teamCount()} teams · 2 each` : 'Teams') : 'Free-for-all', r.opts.timer ? `${r.opts.timer}s turns` : 'No timer'];
    if (r.opts.quickMode) parts.push(`Quick · ${r.opts.quickMode} home`);
    if (r.opts.blockades) parts.push('Blockades');
    if (r.opts.captureToEnterHome) parts.push('Capture to enter home');
    if (r.opts.teamMode) parts.push(r.opts.assist ? 'Assist on' : 'Assist off');
    if (r.spectators) parts.push(`${r.spectators} watching`);
    $('#lobby-rules').replaceChildren(...parts.map((p) => h('li', {}, p)));

    const hold = coarse.matches ? 'Hold and drag' : 'Drag';
    $('#lobby-tip').textContent = !inLobby() ? (you.spectator ? "You're watching this room." : '')
      : you.host ? `${hold} players to swap seats${r.opts.teamMode ? ' or teams' : ''} · tap for options`
        : r.seats.some((s) => s.kind === 'empty') ? `${hold} yourself to an open seat, or tap one to sit there.` : '';
    renderSeats();

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
    const bots = r.fillBots && r.seats.some((s) => s.kind === 'empty') ? ' Open seats get bots.' : '';
    $('#lobby-hint').textContent = humans.length < 2
      ? 'Waiting for at least one more player. Share the code!'
      : notReady.length ? `Waiting for ${notReady.map((s) => s.name).join(', ')} to be ready`
        : you.host ? `Everyone is ready!${bots}` : 'Waiting for the host to start';
    $('#lobby-hint').classList.toggle('good', canStart);
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
      refreshTeamSplit();
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
