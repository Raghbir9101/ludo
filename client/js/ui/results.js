// Results screen: trophy, podium and full ranking.
import { COLORS } from '/shared/rules.js';
import { $, h, announce, avatarEl } from './dom.js';
import { ordinal } from './game.js';

export function showResults(ctrl, ranks) {
  const st = ctrl.state;
  const name = (s) => ctrl.players[s]?.name || COLORS[st.players[s].color].name;
  const color = (s) => COLORS[st.players[s].color].hex;
  const avatar = (s) => ctrl.players[s]?.avatar || '🙂';
  const team = !!st.opts.teamMode;
  let entries;
  if (team) {
    entries = ranks.map((t) => {
      const members = st.players.filter((p) => p.active && p.team === t).map((p) => p.seat);
      return { label: `Team ${'AB'[t]}`, sub: members.map(name).join(', '), color: color(members[0]), seats: members, mine: members.some((s) => ctrl.mySeats.has(s)) };
    });
  } else {
    entries = ranks.map((s) => ({ label: name(s), sub: '', color: color(s), seats: [s], mine: ctrl.mySeats.has(s) }));
  }
  const face = (s, cls, style) => avatarEl({ pic: ctrl.players[s]?.pic, avatar: avatar(s) }, cls, style);
  const faces = (e, cls) => e.seats.length === 1
    ? face(e.seats[0], cls)
    : h('span', { class: `avatar-group ${cls}-group` }, e.seats.map((s) => face(s, cls, { '--pc': color(s) })));
  const shared = ctrl.mySeats.size > 1 && !team;
  if (shared) entries.forEach((e) => { e.mine = false; });
  const mineAt = entries.findIndex((e) => e.mine);
  const who = team ? 'Your team' : 'You';
  $('#results-title').textContent = shared ? `${entries[0].label} wins!`
    : ctrl.isSpectator || mineAt < 0 ? 'Game over' : mineAt === 0 ? `${who} ${team ? 'wins' : 'win'}!` : `${who} placed ${ordinal(mineAt + 1)}`;
  const iWon = mineAt === 0 || shared;
  $('#results-trophy').textContent = iWon || ctrl.isSpectator ? '🏆' : '🎖️';
  const trophy = $('#results-trophy');
  trophy.style.animation = 'none';
  void trophy.offsetWidth;
  trophy.style.animation = '';

  const podium = $('#podium');
  const order = [1, 0, 2].filter((i) => entries[i]);
  const heights = { 0: 110, 1: 80, 2: 60 };
  podium.replaceChildren(...order.map((i) => {
    const e = entries[i];
    return h('div', { class: 'pod', style: { '--pc': e.color } },
      faces(e, 'avatar'),
      h('span', { class: 'nm' }, e.label),
      h('div', { class: 'block', style: { height: `${heights[i]}px` } }, String(i + 1)));
  }));
  $('#rank-list').replaceChildren(...entries.map((e, i) => h('li', { style: { borderLeft: `8px solid ${e.color}` } },
    h('span', { class: 'rk' }, ordinal(i + 1)),
    faces(e, 'face'),
    h('span', { class: 'who' }, h('span', {}, `${e.label}${e.mine ? ' (you)' : ''}`), e.sub ? h('small', {}, e.sub) : null))));
  announce(`${$('#results-title').textContent}. Winner: ${entries[0]?.label}.`);
}
