export class ChangeDetector {
  constructor({ minScore = 0.95, minMargin = 0.08, votesRequired = 3 } = {}) {
    this.minScore = minScore;
    this.minMargin = minMargin;
    this.votesRequired = Math.max(2, votesRequired);
    this.reset();
  }

  reset() {
    this.candidateId = null;
    this.votes = 0;
  }

  observe({ lockedCandidateId, candidate }) {
    if (!lockedCandidateId || !candidate?.id) {
      this.reset();
      return { action: 'RESET', candidateId: null, votes: 0, reason: 'missing_identity' };
    }
    if (candidate.id === lockedCandidateId) {
      this.reset();
      return { action: 'SAME', candidateId: lockedCandidateId, votes: 0, reason: 'locked_identity_reconfirmed' };
    }
    if (candidate.embeddingVerified !== true || Number(candidate.score || 0) < this.minScore || Number(candidate.margin || 0) < this.minMargin) {
      this.reset();
      return { action: 'INSUFFICIENT', candidateId: candidate.id, votes: 0, reason: 'change_evidence_below_threshold' };
    }
    if (this.candidateId === candidate.id) this.votes += 1;
    else { this.candidateId = candidate.id; this.votes = 1; }

    if (this.votes >= this.votesRequired) {
      return { action: 'CONFIRMED', candidateId: this.candidateId, votes: this.votes, reason: 'consecutive_strong_change_evidence' };
    }
    return { action: 'PENDING', candidateId: this.candidateId, votes: this.votes, reason: 'change_confirmation_pending' };
  }
}
