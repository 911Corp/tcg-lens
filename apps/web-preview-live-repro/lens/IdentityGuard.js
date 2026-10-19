export function createTrackToken(context, track) {
  return {
    generation: context?.generation ?? null,
    trackId: track?.id ?? null,
  };
}

export function isTrackTokenCurrent({ running, context, track }, token) {
  const current = createTrackToken(context, track);
  return Boolean(running)
    && token?.generation != null
    && token.generation === current.generation
    && token.trackId === current.trackId;
}

export function createIdentityToken(context, track) {
  const temporal = context?.consensus?.summary?.() || null;
  return {
    ...createTrackToken(context, track),
    candidateId: context?.visualEvidence?.candidateId ?? null,
    temporalCandidateId: temporal?.top?.candidateId ?? null,
    temporalEpoch: temporal?.epoch ?? 0,
  };
}

export function isIdentityTokenCurrent({ running, context, track }, token) {
  const current = createIdentityToken(context, track);
  return isTrackTokenCurrent({ running, context, track }, token)
    && token?.candidateId != null
    && token.candidateId === current.candidateId
    && token.temporalCandidateId === current.temporalCandidateId
    && token.temporalEpoch === current.temporalEpoch;
}
