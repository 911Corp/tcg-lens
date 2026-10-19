export class BenchmarkEvaluator {
  evaluateScenario({ id, events, segments, requirements = {} }) {
    const locks = events.filter(event => event.type === 'LOCK');
    const falseLocks = locks.filter(lock => lock.candidateId !== lock.expected);
    const correctLocks = locks.filter(lock => lock.candidateId === lock.expected && lock.expected != null);
    const emptyFalseLocks = locks.filter(lock => lock.expected == null);
    const crossIdentityDecisions = events.filter(event => event.type === 'FUSION'
      && ['VERIFY', 'LOCK'].includes(event.decision?.decision)
      && event.temporal?.candidateId
      && event.decision?.candidateId
      && event.temporal.candidateId !== event.decision.candidateId);
    const illegalTransitions = events.filter(event => event.type === 'STATE_REJECTED');

    const identitySegments = segments.filter(segment => segment.expectedCandidateId != null);
    const segmentResults = identitySegments.map(segment => {
      const lock = locks.find(event => event.t >= segment.startMs && event.t < segment.endMs && event.candidateId === segment.expectedCandidateId);
      return {
        label: segment.label,
        expectedCandidateId: segment.expectedCandidateId,
        locked: Boolean(lock),
        firstCorrectLockAtMs: lock?.t ?? null,
        lockLatencyMs: lock ? lock.t - segment.startMs : null,
      };
    });
    const lockedSegments = segmentResults.filter(segment => segment.locked).length;
    const segmentLockCoverage = identitySegments.length ? lockedSegments / identitySegments.length : 1;
    const lockPrecision = locks.length ? correctLocks.length / locks.length : 1;
    const fcir = locks.length ? falseLocks.length / locks.length : 0;

    const gates = {
      zeroFalseConfidentLocks: falseLocks.length === 0,
      zeroEmptyFalseLocks: emptyFalseLocks.length === 0,
      zeroCrossIdentityDecisions: crossIdentityDecisions.length === 0,
      zeroIllegalTransitions: illegalTransitions.length === 0,
      minimumSegmentCoverage: segmentLockCoverage >= (requirements.minSegmentCoverage ?? 0),
      requiredLockSequence: !requirements.lockSequence || JSON.stringify(locks.map(lock => lock.candidateId)) === JSON.stringify(requirements.lockSequence),
    };

    return {
      id,
      metrics: {
        totalLocks: locks.length,
        correctLocks: correctLocks.length,
        falseConfidentLocks: falseLocks.length,
        falseConfidentIdentificationRate: fcir,
        lockPrecision,
        emptyFalseLocks: emptyFalseLocks.length,
        crossIdentityDecisions: crossIdentityDecisions.length,
        illegalTransitions: illegalTransitions.length,
        segmentLockCoverage,
      },
      segmentResults,
      gates,
      pass: Object.values(gates).every(Boolean),
    };
  }

  aggregate(results, { productionEvidence = false } = {}) {
    const totalLocks = results.reduce((sum, result) => sum + result.metrics.totalLocks, 0);
    const falseLocks = results.reduce((sum, result) => sum + result.metrics.falseConfidentLocks, 0);
    const correctLocks = results.reduce((sum, result) => sum + result.metrics.correctLocks, 0);
    return {
      productionEvidence,
      scenarioCount: results.length,
      passingScenarios: results.filter(result => result.pass).length,
      totalLocks,
      correctLocks,
      falseConfidentLocks: falseLocks,
      falseConfidentIdentificationRate: totalLocks ? falseLocks / totalLocks : 0,
      lockPrecision: totalLocks ? correctLocks / totalLocks : 1,
      pass: results.every(result => result.pass),
      scenarios: results,
    };
  }
}
