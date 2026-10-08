// Server-side entry to the pure rules engine. The engine itself lives in /shared so the
// browser can run identical rules offline; this module adds the server's dice source.
import { randomInt } from 'node:crypto';
import * as engine from '../shared/engine.js';

export * from '../shared/engine.js';

export const rollDie = () => randomInt(1, 7);

export function rollWithServerDice(state) {
  return engine.roll(state, rollDie());
}
