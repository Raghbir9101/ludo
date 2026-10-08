// Friends screen, home badge, room invites and server notices.
import { $, h, segmented, toast, modal, closeModal, avatarEl, announce } from './dom.js';
import { net } from '../net.js';
import { account } from '../account.js';
import { social } from '../social.js';
import { audio } from '../audio.js';

const STATUS = { lobby: 'In a lobby', playing: 'Playing', online: 'Online', offline: 'Offline' };

export function personRow(p, sub, actions = []) {
  return h('li', { class: 'person' },
    avatarEl(p),
    h('div', { class: 'who' }, h('span', { class: 'nm' }, p.name), sub ? h('small', {}, sub) : null),
    h('div', { class: 'acts' }, actions));
}

const act = (label, cls, onClick, aria) => h('button', {
  type: 'button', class: `btn small ${cls}`, 'aria-label': aria || null,
  onclick: () => { audio.play('tap'); onClick(); },
}, label);

export function friendsScreen({ online, inLobby }) {
  let tab = 'list';
  let searchTimer = 0;
  let lastResults = null;

  const tabs = segmented($('#friends-tabs'), [
    { value: 'list', label: 'Friends' }, { value: 'requests', label: 'Requests' }, { value: 'add', label: 'Add' },
  ], tab, (v) => { tab = v; render(); });

  const joinRoom = (code) => online().then((o) => o.joinByLink(code));

  function friendActions(f) {
    const out = [];
    if (f.status === 'lobby' && f.room) out.push(act('JOIN', 'c-green', () => joinRoom(f.room), `Join ${f.name}'s room`));
    if (inLobby() && f.status !== 'offline' && f.status !== 'lobby') out.push(act('INVITE', 'c-purple', () => net.send('invite', { id: f.id }), `Invite ${f.name}`));
    out.push(act('✕', 'c-red', () => confirmRemove(f), `Remove ${f.name}`));
    return out;
  }

  function confirmRemove(f) {
    modal({
      title: 'Remove friend?',
      body: `${f.name} will be removed from your friends.`,
      actions: [
        { label: 'REMOVE', cls: 'c-red', onClick: () => net.send('friendRemove', { id: f.id }) },
        { label: 'CANCEL', cls: 'c-blue' },
      ],
    });
  }

  function relationActions(u) {
    const rel = social.relation(u.id) || u.relation;
    if (rel === 'friend') return [h('span', { class: 'tag-pill' }, 'Friends')];
    if (rel === 'sent') return [h('span', { class: 'tag-pill' }, 'Sent')];
    if (rel === 'received') return [act('ACCEPT', 'c-green', () => net.send('friendRespond', { id: u.id, accept: true }))];
    return [act('ADD', 'c-green', () => net.send('friendAdd', { id: u.id }), `Add ${u.name}`)];
  }

  function render() {
    const user = account.user;
    $('#friends-guest').hidden = !!user;
    $('#friends-main').hidden = !user;
    if (!user) return;
    const l = social.list;
    tabs.set(tab);
    const reqBtn = $('#friends-tabs [data-value="requests"]');
    reqBtn.textContent = social.requestCount ? `Requests (${social.requestCount})` : 'Requests';
    for (const t of ['list', 'requests', 'add']) $(`#ftab-${t}`).hidden = t !== tab;
    if (!l) {
      $('#friends-list').replaceChildren(h('li', { class: 'hint' }, 'Loading...'));
      $('#friends-empty').hidden = true;
      return;
    }
    $('#friends-list').replaceChildren(...l.friends.map((f) => {
      const row = personRow(f, f.status === 'lobby' && f.room ? `${STATUS.lobby} · ${f.room}` : STATUS[f.status], friendActions(f));
      row.classList.add(`st-${f.status}`);
      return row;
    }));
    $('#friends-empty').hidden = l.friends.length > 0;
    $('#friends-incoming').replaceChildren(...(l.incoming.length ? l.incoming.map((u) => personRow(u, 'Wants to be friends', [
      act('ACCEPT', 'c-green', () => net.send('friendRespond', { id: u.id, accept: true }), `Accept ${u.name}`),
      act('DECLINE', 'c-red', () => net.send('friendRespond', { id: u.id, accept: false }), `Decline ${u.name}`),
    ])) : [h('li', { class: 'hint' }, 'No new requests')]));
    $('#friends-outgoing').replaceChildren(...(l.outgoing.length ? l.outgoing.map((u) => personRow(u, 'Waiting for reply', [
      act('CANCEL', 'c-red', () => net.send('friendRemove', { id: u.id }), `Cancel request to ${u.name}`),
    ])) : [h('li', { class: 'hint' }, 'No pending requests')]));
    $('#my-friend-code').textContent = l.code || '--------';
    $('#fb-suggest').hidden = !l.suggestions.length;
    $('#suggestions').replaceChildren(...l.suggestions.map((u) => personRow(u, 'Facebook friend', relationActions(u))));
    if (lastResults) renderResults(lastResults);
  }

  function renderResults(m) {
    lastResults = m;
    $('#search-results').replaceChildren(...(m.results.length
      ? m.results.map((u) => personRow(u, null, relationActions(u)))
      : m.q.length >= 2 ? [h('li', { class: 'hint' }, 'No players found')] : []));
  }

  $('#copy-friend-code').addEventListener('click', async () => {
    audio.play('tap');
    const code = social.list?.code;
    if (!code) return;
    try { await navigator.clipboard.writeText(code); toast('Friend code copied!'); } catch { toast(code, 4000); }
  });
  const codeInput = $('#add-code');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); });
  const addByCode = () => {
    audio.play('tap');
    if (codeInput.value.length < 8) return toast('Friend codes have 8 letters and numbers.');
    net.send('friendAdd', { code: codeInput.value });
    codeInput.value = '';
  };
  $('#add-code-go').addEventListener('click', addByCode);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addByCode(); });
  $('#friend-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => net.send('friendSearch', { q }), 300);
  });
  net.on('friendSearch', renderResults);
  social.on('change', () => { if (isOpen()) render(); });
  account.on('change', () => { if (isOpen()) render(); });
  const isOpen = () => $('#scr-friends').classList.contains('active');

  return {
    show() {
      if (account.user) {
        net.connect();
        net.send('friends');
      }
      render();
    },
  };
}

// Global listeners: request badge, invites, notices. Safe to call once at boot.
export function initSocial({ online, isPlaying }) {
  const badge = () => {
    const n = account.user ? social.requestCount : 0;
    $('#friends-badge').hidden = !n;
    $('#friends-badge').textContent = String(n);
  };
  social.on('change', badge);
  account.on('change', (u) => {
    if (u) net.connect();
    else social.clear();
    badge();
  });
  net.on('notice', (m) => {
    toast(m.msg, 3000);
    announce(m.msg);
    if (m.kind === 'friendRequest') audio.play('chat');
  });
  net.on('error', (m) => {
    if (/^(friend|invite|login)/.test(m.code || '') && m.msg) toast(m.msg, 3000);
  });
  net.on('invite', (m) => {
    audio.play('turn');
    const what = `${m.n}-player ${m.teamMode ? 'team ' : ''}game`;
    if (isPlaying()) return toast(`${m.from.name} invited you to a ${what} (room ${m.code})`, 5000);
    modal({
      title: 'Game invite',
      body: h('div', { class: 'invite-body' }, avatarEl(m.from, 'avatar big'), h('p', {}, `${m.from.name} invited you to a ${what}.`)),
      actions: [
        { label: 'JOIN', cls: 'c-green', onClick: () => online().then((o) => o.joinByLink(m.code)) },
        { label: 'NOT NOW', cls: 'c-blue' },
      ],
    });
  });
}

// Lobby helper: pick online friends to invite into the current room.
export function inviteFriendsModal() {
  net.send('friends');
  const list = h('ul', { class: 'people' });
  const draw = () => {
    const fs = (social.list?.friends || []).filter((f) => f.status !== 'offline');
    list.replaceChildren(...(fs.length ? fs.map((f) => personRow(f, STATUS[f.status], [
      act('INVITE', 'c-purple', () => net.send('invite', { id: f.id }), `Invite ${f.name}`),
    ])) : [h('li', { class: 'hint' }, social.list ? 'None of your friends are online right now.' : 'Loading...')]));
  };
  draw();
  const off = social.on('change', draw);
  modal({
    title: 'Invite friends',
    body: list,
    actions: [{ label: 'DONE', cls: 'c-blue', onClick: () => off() }],
    cancel: () => off(),
  });
}

export { closeModal };
