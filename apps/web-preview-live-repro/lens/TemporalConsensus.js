export class TemporalConsensus {
  constructor({ maxObservations = 8 } = {}) {
    this.maxObservations = maxObservations;
    this.reset();
  }

  reset() {
    this.observations = [];
  }

  observe(observation) {
    if (!observation?.candidateId) return this.summary();
    this.observations.push({ ...observation, at: observation.at ?? Date.now() });
    if (this.observations.length > this.maxObservations) this.observations.shift();
    return this.summary();
  }

  summary() {
    const groups = new Map();
    for (const obs of this.observations) {
      const g = groups.get(obs.candidateId) || { candidateId: obs.candidateId, votes: 0, scoreSum: 0, marginSum: 0, qualitySum: 0 };
      g.votes += 1;
      g.scoreSum += Number(obs.score || 0);
      g.marginSum += Number(obs.margin || 0);
      g.qualitySum += Number(obs.quality || 0);
      groups.set(obs.candidateId, g);
    }
    const ranked = [...groups.values()].map(g => ({
      ...g,
      avgScore: g.scoreSum / g.votes,
      avgMargin: g.marginSum / g.votes,
      avgQuality: g.qualitySum / g.votes,
    })).sort((a, b) => b.votes - a.votes || b.avgScore - a.avgScore);
    return { top: ranked[0] || null, second: ranked[1] || null, ranked, total: this.observations.length };
  }
}
