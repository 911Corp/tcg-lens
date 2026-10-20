#!/usr/bin/env python3
"""v0.4.1 — calibrated proposal probabilities ("Est-ce cette carte ?").

For each held-out camera crop (q-*, never used for training) the deployed index ranks the families. A logistic
model gives every candidate of the top 5 the probability of being the scanned card from rank features:
score, gap to the top, gap to the next, is-top, score², gap², top-1/top-2 margin. It is fitted on in-catalogue
crops AND on the same crops with their true family removed (cards missing from the catalogue, weight
PRIOR_OPEN/(1-PRIOR_OPEN)), so that a merely "best available" match gets a low probability.

Display rule (tuned here, enforced in lens/Proposals.js): proposals only when the top candidate has p ≥ SHOW,
then every candidate with p ≥ INCLUDE (max 3). Requirements: right card among the shown proposals ≥ 97 % on the
held-out half. Writes calibration.proposals into data/deep-index.json (bump nothing else).
  python3 tools/deep/calibrate-proposals.py      (after train-and-export.py; uses $DEEP_WORK/q-*)
"""
import gzip, json, os, sys
import numpy as np
from sklearn.linear_model import LogisticRegression

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
W = os.environ.get('DEEP_WORK', '/tmp/tcg-lens-deep')
K, PRIOR_OPEN, SHOW, INCLUDE, MAX = 5, 0.2, 0.6, 0.1, 3
nz = lambda X: X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

rows, R = [], []
for l in ['fr', 'en', 'ja']:
    m = json.load(open(f'{APP}/data/visual-index-{l}.json')); ii = m['columns'].index('id')
    rows += [r[ii] for r in m['rows']]
    R.append(np.frombuffer(gzip.decompress(open(f'{APP}/data/deep-index-{l}.bin.gz', 'rb').read()), np.int8).reshape(m['count'], -1).astype(np.float32) / 127)
R = np.concatenate(R)
famid = {f: i for i, f in enumerate(dict.fromkeys(rows))}; F = np.array([famid[f] for f in rows])
meta = json.load(open(f'{APP}/data/deep-index.json'))
f = np.frombuffer(gzip.decompress(open(f'{APP}/data/deep-model.bin.gz', 'rb').read()), np.float32)
mu, M = f[:meta['inDims']], f[meta['inDims']:].reshape(meta['inDims'], meta['dims'])
qm = json.load(open(f'{W}/q-meta.json'))
Q = nz(np.fromfile(f'{W}/q-emb.bin', np.float32).reshape(-1, 1280)); QF = nz(np.fromfile(f'{W}/q-fast.bin', np.float32).reshape(-1, 236))
ok = np.linalg.norm(Q, axis=1) > 0.5; qm = [x for x, k in zip(qm, ok) if k]; Q, QF = Q[ok], QF[ok]
wf = meta['fastWeight']
q = nz((np.concatenate([Q * (1 - wf) ** .5, QF * wf ** .5], 1) - mu) @ M).astype(np.float32)
order = np.argsort(F, kind='stable'); starts = np.r_[0, np.flatnonzero(np.diff(F[order])) + 1]
FS = np.concatenate([np.maximum.reduceat((q[a:a + 256] @ R.T)[:, order], starts, axis=1) for a in range(0, len(q), 256)])
qf = np.array([famid[m['id']] for m in qm]); files = np.array([m['file'] for m in qm])

def ranked(fs, drop=None):
    fs = fs.copy()
    if drop is not None: fs[drop] = -9
    top = np.argsort(-fs)[:K + 1]; return top[:K], fs[top]

def design(s):  # s: [..., K+1] sorted scores → [..., K, 7]
    out = []
    for r in range(K):
        sr = s[..., r]; gap = s[..., 0] - sr; nxt = sr - s[..., r + 1]
        out.append(np.stack([sr, gap, nxt, np.full_like(sr, r == 0, dtype=float), sr * sr, gap * gap, np.minimum(s[..., 0] - s[..., 1], 0.3)], -1))
    return np.stack(out, -2)

S, Y, So = [], [], []
for k in range(len(q)):
    top, s = ranked(FS[k]); S.append(s); Y.append(top == qf[k])
    _, so = ranked(FS[k], qf[k]); So.append(so)
S, Y, So = np.array(S), np.array(Y).astype(int), np.array(So)
uf = np.unique(files); test = set(np.random.default_rng(0).choice(uf, len(uf) // 2, replace=False))
te = np.array([x in test for x in files]); tr = ~te
w_open = PRIOR_OPEN / (1 - PRIOR_OPEN)
Xtr = np.concatenate([design(S[tr]).reshape(-1, 7), design(So[tr]).reshape(-1, 7)])
Ytr = np.concatenate([Y[tr].reshape(-1), np.zeros(tr.sum() * K)])
Wtr = np.concatenate([np.ones(tr.sum() * K), np.full(tr.sum() * K, w_open)])
clf = LogisticRegression(C=10, max_iter=3000).fit(Xtr, Ytr, sample_weight=Wtr)
P = clf.predict_proba(design(S[te]).reshape(-1, 7))[:, 1].reshape(-1, K); Po = clf.predict_proba(design(So[te]).reshape(-1, 7))[:, 1].reshape(-1, K)
gate = P[:, 0] >= SHOW; shown = (P >= INCLUDE) & gate[:, None]; shown[:, MAX:] = False
hit = (shown & (Y[te] == 1)).any(1)
stats = {'heldOutCrops': int(te.sum()), 'shownInCatalogue': round(float(gate.mean()), 4), 'rightAmongShown': round(float(hit[gate].mean()), 4),
         'avgProposals': round(float(shown.sum(1)[gate].mean()), 2), 'shownNotInCatalogue': round(float((Po[:, 0] >= SHOW).mean()), 4)}
print(json.dumps(stats, indent=1))
if stats['rightAmongShown'] < 0.97: sys.exit('proposal gate failed: right card among shown proposals < 97 %')
meta.setdefault('calibration', {})['proposals'] = {'features': 'v1:score,gap,next,isTop,score2,gap2,margin12', 'k': K, 'coef': [round(float(c), 6) for c in clf.coef_[0]],
    'intercept': round(float(clf.intercept_[0]), 6), 'priorOpen': PRIOR_OPEN, 'show': SHOW, 'include': INCLUDE, 'max': MAX, **stats}
json.dump(meta, open(f'{APP}/data/deep-index.json', 'w'), indent=1)
print('written calibration.proposals')
