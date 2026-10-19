export class FrameSampler {
  constructor(intervalMs = 125) {
    this.intervalMs = intervalMs;
    this.lastAt = 0;
  }
  shouldSample(at = performance.now()) {
    if (at - this.lastAt < this.intervalMs) return false;
    this.lastAt = at;
    return true;
  }
  reset() { this.lastAt = 0; }
}
