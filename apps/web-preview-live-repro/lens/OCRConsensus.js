export class OCRConsensus {
  constructor({ requiredExactVotes = 2, requiredNameVotes = 2, maxObservations = 5 } = {}) {
    this.requiredExactVotes = Math.max(2, requiredExactVotes);
    this.requiredNameVotes = Math.max(2, requiredNameVotes);
    this.maxObservations = Math.max(this.requiredExactVotes, maxObservations);
    this.reset();
  }

  reset() {
    this.observations = [];
    this.hardContradiction = null;
    this.latest = null;
    this.metadataContradictions = new Map();
  }

  observe(evidence, expectedCandidateId = null) {
    if (!evidence?.available) return this.summary(expectedCandidateId);
    const obs = {
      candidateId: evidence.candidateId || null,
      collectorExact: evidence.collectorExact === true,
      strongNameMatch: evidence.strongNameMatch === true,
      contradiction: evidence.contradiction === true,
      at: evidence.at ?? Date.now(),
      text: evidence.text || '',
    };
    this.latest = evidence;
    const exactOtherCandidate = Boolean(
      expectedCandidateId && obs.candidateId && obs.candidateId !== expectedCandidateId && obs.collectorExact
    );
    // v0.3.1: a printed number/total that disagrees with the candidate is only a hard contradiction
    // once the SAME mismatching read repeats (2-read consensus). A single noisy OCR read must not
    // poison the whole track. Exact-other-candidate contradictions still block immediately.
    if (obs.contradiction && evidence.contradictionKind === 'printed_metadata') {
      const sig = String(evidence.contradictionSignature || '');
      const n = (this.metadataContradictions.get(sig) || 0) + 1;
      this.metadataContradictions.set(sig, n);
      if (n < this.requiredExactVotes) {
        obs.contradiction = false;
        obs.collectorExact = false;
        this.pendingMetadataContradiction = { signature: sig, reads: n };
        return this.summary(expectedCandidateId);
      }
    }
    if (obs.contradiction || exactOtherCandidate) {
      this.hardContradiction = {
        candidateId: obs.candidateId,
        reason: obs.contradiction ? 'ocr_explicit_contradiction' : 'ocr_exact_other_candidate',
        at: obs.at,
      };
    }
    if (obs.candidateId) {
      this.observations.push(obs);
      if (this.observations.length > this.maxObservations) this.observations.shift();
    }
    return this.summary(expectedCandidateId);
  }

  summary(expectedCandidateId = null) {
    const groups = new Map();
    for (const obs of this.observations) {
      const group = groups.get(obs.candidateId) || { candidateId: obs.candidateId, votes: 0, exactVotes: 0, nameVotes: 0 };
      group.votes += 1;
      if (obs.collectorExact) group.exactVotes += 1;
      if (obs.strongNameMatch) group.nameVotes += 1;
      groups.set(obs.candidateId, group);
    }
    const ranked = [...groups.values()].sort((a, b) => b.exactVotes - a.exactVotes || b.nameVotes - a.nameVotes || b.votes - a.votes);
    const target = expectedCandidateId ? groups.get(expectedCandidateId) || null : ranked[0] || null;
    const best = target || ranked[0] || null;
    const contradiction = Boolean(this.hardContradiction);
    return {
      available: this.observations.length > 0,
      candidateId: best?.candidateId || null,
      collectorExact: Boolean(target && target.exactVotes >= this.requiredExactVotes),
      strongNameMatch: Boolean(target && target.nameVotes >= this.requiredNameVotes),
      printingSupport: Boolean(target && target.exactVotes >= this.requiredExactVotes),
      conceptSupport: Boolean(target && target.nameVotes >= this.requiredNameVotes),
      contradiction,
      contradictionReason: this.hardContradiction?.reason || null,
      exactVotes: target?.exactVotes || 0,
      nameVotes: target?.nameVotes || 0,
      observations: this.observations.length,
      ranked,
      latest: this.latest,
    };
  }
}
