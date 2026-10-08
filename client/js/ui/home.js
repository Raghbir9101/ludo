// Home screen: profile chip and main menu.
import { $, avatarEl } from './dom.js';
import { prefs, displayName } from '../prefs.js';
import { account } from '../account.js';

export function homeScreen() {
  const render = () => {
    const chip = $('#home-avatar');
    chip.replaceWith(Object.assign(avatarEl({ pic: account.user?.pic, avatar: prefs.avatar }), { id: 'home-avatar' }));
    $('#home-name').textContent = displayName();
  };
  const net = () => { $('#offline-note').hidden = navigator.onLine; };
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
