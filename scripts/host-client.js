// Headless host for manual testing: creates a room, prints the code, starts once someone is ready.
// Usage: node scripts/host-client.js [players] [team]
import { playClient } from './bot-client.js';

const n = Number(process.argv[2]) || 4;
const team = process.argv[3] === 'team';
let started = false;
playClient({
  url: 'ws://localhost:8080/ws', name: 'NodeHost', thinkMs: 600,
  create: { n, teamMode: team },
  onRoom: (r, c) => {
    if (!started) console.log('code', r.code);
    const others = r.seats.filter((s) => s.kind === 'human' && !s.host);
    if (!started && others.length && others.every((s) => s.ready)) {
      started = true;
      c.send({ t: 'start' });
    }
  },
  onMessage: (m) => { if (m.t === 'error') console.log('error', m.code); },
  onGameOver: () => { console.log('game over'); process.exit(0); },
});
