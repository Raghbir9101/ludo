// Small DOM helpers shared by the screens.
import { audio } from '../audio.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Round avatar: the account photo when there is one, otherwise the emoji avatar.
export function avatarEl(meta, cls = 'avatar', style = null) {
  const el = h('span', { class: cls, style });
  const fallback = () => { el.classList.remove('has-pic'); el.textContent = meta?.avatar || '🙂'; };
  if (meta?.pic) {
    const img = h('img', { src: meta.pic, alt: '', referrerpolicy: 'no-referrer', decoding: 'async', draggable: 'false' });
    img.addEventListener('error', fallback, { once: true });
    el.classList.add('has-pic');
    el.append(img);
  } else {
    fallback();
  }
  return el;
}

let toastTimer = 0;
export function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

let liveFlip = false;
// Screen-reader announcement through an aria-live region.
export function announce(msg, urgent = false) {
  const el = $(urgent ? '#live-urgent' : '#live');
  liveFlip = !liveFlip;
  el.textContent = msg + (liveFlip ? '' : '\u200b');
}

// Segmented control. options: [{value, label}]
export function segmented(container, options, value, onChange) {
  container.replaceChildren();
  container.setAttribute('role', 'group');
  const buttons = options.map((o) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === value), 'data-value': String(o.value) }, o.label);
    b.addEventListener('click', () => {
      audio.play('tap');
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onChange(o.value);
    });
    return b;
  });
  container.append(...buttons);
  return {
    set(v) { buttons.forEach((x, i) => x.setAttribute('aria-pressed', String(options[i].value === v))); },
  };
}

let modalReturnFocus = null;
let modalCancel = null;

// `cancel` runs when the modal is dismissed with Escape (defaults to just closing).
export function modal({ title, body = '', actions = [], cancel = null }) {
  const m = $('#game-modal');
  if (m.hidden) modalReturnFocus = document.activeElement;
  modalCancel = cancel;
  $('#modal-title').textContent = title;
  const b = $('#modal-body');
  b.replaceChildren(typeof body === 'string' ? document.createTextNode(body) : body);
  const a = $('#modal-actions');
  a.replaceChildren(...actions.map((x) => h('button', { class: `btn ${x.cls || 'c-blue'}`, onclick: () => { audio.play('tap'); if (x.keepOpen !== true) closeModal(); x.onClick?.(); } }, x.label)));
  m.hidden = false;
  a.querySelector('button')?.focus();
  return closeModal;
}

export function closeModal() {
  const m = $('#game-modal');
  if (m.hidden) return;
  m.hidden = true;
  modalCancel = null;
  const el = modalReturnFocus;
  modalReturnFocus = null;
  if (el && el.isConnected && !el.closest('[hidden], .screen:not(.active)')) el.focus({ preventScroll: true });
}

export function modalOpen() {
  return !$('#game-modal').hidden;
}

// Escape dismisses; Tab stays inside the dialog.
export function modalKey(e) {
  const m = $('#game-modal');
  if (m.hidden) return false;
  if (e.key === 'Escape') {
    const cancel = modalCancel;
    closeModal();
    cancel?.();
    return true;
  }
  if (e.key === 'Tab') {
    const f = [...m.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
    if (!f.length) return true;
    const i = f.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 || i < 0 ? 0 : i + 1);
    f[next].focus();
    return true;
  }
  return false;
}
