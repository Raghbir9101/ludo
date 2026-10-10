// Home screen: top bar (photo, settings, name), main menu and tab bar.
import { $, avatarEl } from './dom.js';
import { prefs, displayName } from '../prefs.js';
import { account } from '../account.js';

export function homeScreen() {
  const render = () => {
    const chip = $('#home-avatar');
    chip.replaceWith(Object.assign(avatarEl({ pic: account.user?.pic, avatar: prefs.avatar }), { id: 'home-avatar' }));
    $('#home-name').textContent = displayName();
  };
  const net = () => {
    $('#offline-note').hidden = navigator.onLine;
    $('#home-dot').classList.toggle('on', navigator.onLine);
  };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  account.on('change', render);
  return {
    show() {
      render();
      net();
    },
    render,
  };
}
