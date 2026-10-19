export class BestFrameSelector {
  constructor({ minImprovement = 0.025, maxAgeMs = 1800 } = {}) {
    this.minImprovement = minImprovement;
    this.maxAgeMs = maxAgeMs;
    this.reset();
  }
  reset() { this.best = null; }
  consider({ canvas, quality, at = performance.now(), generation }) {
    const current = this.best;
    const improved = !current || quality.score >= current.quality.score + this.minImprovement;
    const stale = !current || at - current.at >= this.maxAgeMs;
    if (improved || (stale && quality.score >= current.quality.score * 0.94)) {
      const copy = document.createElement('canvas');
      copy.width = canvas.width; copy.height = canvas.height;
      copy.getContext('2d').drawImage(canvas, 0, 0);
      this.best = { canvas: copy, quality, at, generation };
      return this.best;
    }
    return null;
  }
}
