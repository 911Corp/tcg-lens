export class Telemetry {
  constructor({ max = 120, onEvent = () => {} } = {}) { this.max = max; this.events = []; this.onEvent = onEvent; }
  emit(type, detail = {}) {
    const event = { type, detail, at: performance.now?.() ?? Date.now() };
    this.events.push(event); if (this.events.length > this.max) this.events.shift(); this.onEvent(event); return event;
  }
  snapshot() { return [...this.events]; }
}
