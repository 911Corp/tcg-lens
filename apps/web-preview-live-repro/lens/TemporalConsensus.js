export class TemporalConsensus {
  constructor({
    maxObservations = 8,
    strongSwitchScore = 0.94,
    strongSwitchMargin = 0.06,
    switchVotes = 2,
  } = {}) {
    this.maxObservations = maxObservations;
    this.strongSwitchScore = strongSwitchScore;
    this.strongSwitchMargin = strongSwitchMargin;
    this.switchVotes = Math.max(2, switchVotes);
    this.reset();
  }

  reset() {
    this.activeCandidateId = null;
    this.observations = [];
    this.pendingSwitch = null;
    this.epoch = 0;
    this.lastObservationCandidateId = null;
    this.lastAction = 'RESET';
  }

  observe(observation) {
    if (!observation?.candidateId) return this.summary();
    const obs = { ...observation, at: observation.at ?? Date.now() };
    this.lastObservationCandidateId = obs.candidateId;

    if (!this.activeCandidateId) {
      this.activeCandidateId = obs.candidateId;
      this.observations = [obs];
      this.lastAction = 'START';
      return this.summary();
    }

    if (obs.candidateId === this.activeCandidateId) {
      this.pendingSwitch = null;
      this._append(obs);
      this.lastAction = 'ACCUMULATE';
      return this.summary();
    }

    const strongSwitchEvidence = Number(obs.score || 0) >= this.strongSwitchScore
      && Number(obs.margin || 0) >= this.strongSwitchMargin;

    if (!strongSwitchEvidence) {
      this.pendingSwitch = null;
      this.lastAction = 'MISMATCH_REJECTED';
      return this.summary();
    }

    if (this.pendingSwitch?.candidateId === obs.candidateId) {
      this.pendingSwitch.observations.push(obs);
    } else {
      this.pendingSwitch = { candidateId: obs.candidateId, observations: [obs] };
    }

    if (this.pendingSwitch.observations.length < this.switchVotes) {
      this.lastAction = 'SWITCH_PENDING';
      return this.summary();
    }

    this.activeCandidateId = this.pendingSwitch.candidateId;
    this.observations = this.pendingSwitch.observations.slice(-this.maxObservations);
    this.pendingSwitch = null;
    this.epoch += 1;
    this.lastAction = 'SWITCH_ACCEPTED';
    return this.summary();
  }

  _append(observation) {
    this.observations.push(observation);
    if (this.observations.length > this.maxObservations) this.observations.shift();
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
    return {
      top: ranked[0] || null,
      second: ranked[1] || null,
      ranked,
      total: this.observations.length,
      activeCandidateId: this.activeCandidateId,
      epoch: this.epoch,
      lastObservationCandidateId: this.lastObservationCandidateId,
      lastAction: this.lastAction,
      pendingSwitch: this.pendingSwitch ? {
        candidateId: this.pendingSwitch.candidateId,
        votes: this.pendingSwitch.observations.length,
      } : null,
    };
  }
}
