export class Emitter {
  constructor() {
    this.handlers = new Map();
  }

  on(ev, fn) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev).add(fn);
    return () => this.handlers.get(ev)?.delete(fn);
  }

  emit(ev, ...args) {
    for (const fn of [...(this.handlers.get(ev) || [])]) fn(...args);
  }
}
