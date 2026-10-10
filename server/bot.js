// Server-side bot for filled, disconnected and AFK seats.
import { chooseMove, botDelay } from '../shared/botcore.js';

export { chooseMove };

export function botThinkMs(scale = 1) {
  return Math.round(botDelay() * scale);
}

// Rough time the clients need to animate a batch of events, so bots and timers wait for it.
export function animMs(events, scale = 1) {
  let ms = 0;
  for (const e of events) {
    switch (e.t) {
      case 'rolled': ms += 820; break;
      case 'moved': ms += e.exit ? 800 : e.path.length * 205 + 230; break;
      case 'captured': ms += 1150; break;
      case 'reachedHome': ms += 280; break;
      case 'noMoves': ms += 680; break;
      case 'turnChanged': ms += 140; break;
      case 'playerFinished': ms += 720; break;
      case 'teamFinished': ms += 620; break;
      case 'gameOver': ms += 1800; break;
    }
  }
  return Math.round(ms * scale);
}
