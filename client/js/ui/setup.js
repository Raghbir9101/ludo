// Mode / player-count select for offline play (solo and team vs bots).
import { COLORS, DEFAULT_SEAT_COLORS, TEAM_COUNTS, teamOf, teamCountFor, teamSplitLabel } from '/shared/rules.js';
import { $, h, segmented } from './dom.js';
import { prefs, savePrefs, displayName, BOT_AVATAR, AVATARS } from '../prefs.js';
import { audio } from '../audio.js';
import { account } from '../account.js';

const TITLES = { solo: 'Computer', team: 'Team Up', pass: 'Pass N Play' };

export const BOT_NAMES = ['Pip', 'Dot', 'Bix', 'Zuzu', 'Momo', 'Kiki', 'Taro', 'Nova'];

// The human sits in the bottom-left yard (seat n-1).
export const humanSeat = (n) => n - 1;

export function assignColors(n, seat, color) {
  const out = Array(n).fill(-1);
  out[seat] = color;
  const pool = [...DEFAULT_SEAT_COLORS[n], ...COLORS.map((c) => c.id)].filter((c, i, a) => a.indexOf(c) === i && c !== color);
  for (let s = 0; s < n; s++) if (out[s] < 0) out[s] = pool.shift();
  return out;
}

export function setupScreen({ onStart, onCreateTeamRoom }) {
  let mode = 'solo';
  const cfg = {
    n: prefs.lastCount || 4,
    teamCount: 2,
    color: prefs.lastColor ?? 0,
    difficulty: prefs.lastDifficulty || 'medium',
    quick: 0,
  };

  const countSeg = segmented($('#setup-count'), [4, 6, 8].map((v) => ({ value: v, label: String(v) })), cfg.n, (v) => {
    cfg.n = v;
    renderColors();
    renderTeam();
  });
  segmented($('#setup-diff'), [
    { value: 'easy', label: 'Easy' }, { value: 'medium', label: 'Medium' }, { value: 'hard', label: 'Hard' },
  ], cfg.difficulty, (v) => { cfg.difficulty = v; });
  segmented($('#setup-quick'), [
    { value: 0, label: 'Classic' }, { value: 1, label: 'Quick: 1 home' }, { value: 2, label: 'Quick: 2 home' },
  ], 0, (v) => { cfg.quick = v; });

  function renderColors() {
    const wrap = $('#setup-colors');
    wrap.setAttribute('role', 'radiogroup');
    wrap.replaceChildren(...COLORS.map((c) => {
      const b = h('button', {
        type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(c.id === cfg.color),
        'aria-label': c.name, style: { background: c.hex },
      });
      b.addEventListener('click', () => {
        audio.play('tap');
        cfg.color = c.id;
        renderColors();
      });
      return b;
    }));
  }

  function renderTeam() {
    const n = cfg.n;
    const options = TEAM_COUNTS[n] || [2];
    const wrap = $('#setup-teams');
    wrap.hidden = options.length < 2;
    cfg.teamCount = teamCountFor(n, cfg.teamCount);
    if (!wrap.hidden) {
      segmented(wrap, options.map((c) => ({ value: c, label: teamSplitLabel(n, c) })), cfg.teamCount, (v) => {
        cfg.teamCount = v;
        renderTeam();
      });
    }
    const count = cfg.teamCount;
    const each = n / count;
    const partners = each - 1;
    $('#setup-team-info').textContent = count === 2
      ? `You + ${partners} bot partner${partners > 1 ? 's' : ''} vs ${each} bots. Partners sit opposite.`
      : `${count} teams of ${each}. You + 1 bot partner vs ${count - 1} other pairs. Partners sit opposite.`;
  }

  $('#setup-start').addEventListener('click', () => {
    audio.play('tap');
    savePrefs({ lastCount: cfg.n, lastColor: cfg.color, lastDifficulty: cfg.difficulty });
    const n = cfg.n;
    const me = humanSeat(n);
    let seats;
    if (mode === 'pass') {
      seats = DEFAULT_SEAT_COLORS[n].map((color, s) => ({ name: `Player ${s + 1}`, avatar: AVATARS[s % AVATARS.length], color }));
    } else {
      const colors = assignColors(n, me, cfg.color);
      let b = 0;
      seats = colors.map((color, s) => (s === me
        ? { name: displayName(), avatar: prefs.avatar, pic: account.user?.pic || null, color }
        : { name: BOT_NAMES[b++ % BOT_NAMES.length], avatar: BOT_AVATAR, color, bot: true, difficulty: cfg.difficulty }));
    }
    const opts = {
      teamMode: mode === 'team',
      teamCount: mode === 'team' ? teamCountFor(n, cfg.teamCount) : 2,
      assist: $('#setup-assist').checked,
      quickMode: cfg.quick,
      blockades: $('#setup-blockades').checked,
      captureToEnterHome: $('#setup-capture').checked,
    };
    if (opts.teamMode) seats.forEach((s, i) => { s.team = teamOf(i, opts.teamCount); });
    onStart({ n, seats, opts, title: TITLES[mode] });
  });
  $('#setup-online').addEventListener('click', () => {
    audio.play('tap');
    onCreateTeamRoom({ n: cfg.n });
  });

  return {
    show(m) {
      mode = m;
      $('#setup-title').textContent = TITLES[m];
      $('#setup-team-field').hidden = m !== 'team';
      $('#setup-color-field').hidden = m === 'pass';
      $('#setup-diff').closest('fieldset').hidden = m === 'pass';
      $('#setup-online').hidden = m !== 'team';
      $('#setup-start').textContent = m === 'team' ? 'PLAY VS BOTS' : 'START';
      countSeg.set(cfg.n);
      renderColors();
      renderTeam();
    },
  };
}
