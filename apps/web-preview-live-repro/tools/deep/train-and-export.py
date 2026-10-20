#!/usr/bin/env python3
"""Step 3 — learned whitening, held-out calibration and export of the calibrated instant index.

Pipeline (v0.3.5):
  node tools/deep/embed-references.mjs <fr|en|ja> 0 2   and   ... 1 2      # reference embeddings
  TRAIN=1 node tools/deep/camera-crops.mjs                                 # training crops
  node tools/deep/camera-crops.mjs                                         # held-out crops
  python3 tools/deep/train-and-export.py                                   # this script

Method: feature = [MobileNet embedding (1280) · sqrt(1-w), fast descriptor (236) · sqrt(w)], w = 0.5.
Within-class covariance Cw of (camera crop − reference) differences → Cw^-1/2 (regularized), then PCA
of the whitened references → 128 dims. Thresholds: twin-aware margin (best non-twin family) and an
open-set test (true family removed) on held-out crops. Writes data/deep-index.json,
data/deep-model.bin.gz and data/deep-index-{lang}.bin.gz. After a rebuild, bump ASSET_CACHE in sw.js.
"""
import gzip, json, os, sys
import numpy as np

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WORK = os.environ.get('DEEP_WORK', '/tmp/tcg-lens-deep')
LANGS = ['fr', 'en', 'ja']
WF, D, REG, TAU = 0.5, 128, 0.3, 0.80
INSTANT_SCORE, INSTANT_MARGIN = 0.80, 0.06

nz = lambda X: X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
rows, embs, fasts, keys, counts = [], [], [], [], []
for l in LANGS:
    meta = json.load(open(f'{APP}/data/visual-index-{l}.json'))
    n = meta['count']; ii = meta['columns'].index('id'); counts.append(n)
    embs.append(sum(np.fromfile(f'{WORK}/emb-{l}-{p}.bin', np.float32).reshape(n, 1280) for p in (0, 1)))
    fasts.append(np.fromfile(f'{APP}/data/visual-index-{l}.bin', np.int8).reshape(n, meta['dims']).astype(np.float32) / 127)
    rows += [r[ii] for r in meta['rows']]; keys += [(l, i) for i in range(n)]
E, FA = nz(np.concatenate(embs)), nz(np.concatenate(fasts))
kidx = {k: i for i, k in enumerate(keys)}
famid = {f: i for i, f in enumerate(dict.fromkeys(rows))}; F = np.array([famid[f] for f in rows]); NF = len(famid)
feat = lambda Dp, Fa: np.concatenate([Dp * (1 - WF) ** .5, Fa * WF ** .5], 1)

def crops(pre):
    m = json.load(open(f'{WORK}/{pre}meta.json'))
    Q = nz(np.fromfile(f'{WORK}/{pre}emb.bin', np.float32).reshape(-1, 1280)); QF = nz(np.fromfile(f'{WORK}/{pre}fast.bin', np.float32).reshape(-1, 236))
    ok = np.linalg.norm(Q, axis=1) > 0.5
    return [x for x, k in zip(m, ok) if k], Q[ok], QF[ok]

tm, TQ, TF = crops('t-'); qm, Q, QF = crops('q-')
R0, T0, Q0 = feat(E, FA), feat(TQ, TF), feat(Q, QF)
diff = T0 - R0[np.array([kidx[(m['lang'], m['row'])] for m in tm])]
mu = R0.mean(0); Cw = diff.T @ diff / len(diff)
w, V = np.linalg.eigh(Cw + REG * np.trace(Cw) / Cw.shape[0] * np.eye(Cw.shape[0]))
P = V / np.sqrt(w)
Rw = (R0 - mu) @ P
_, _, Vt = np.linalg.svd(Rw - Rw.mean(0), full_matrices=False)
M = P @ Vt[:D].T
proj = lambda X: nz((X - mu) @ M)
R, q = proj(R0).astype(np.float32), proj(Q0)

# Held-out calibration (closed set + open set, twin-aware margin).
qf = np.array([famid[m['id']] for m in qm]); lvl = np.array([m['level'] for m in qm])
FS = np.full((len(q), NF), -9, np.float32)
S = q @ R.T
for k in range(len(q)): np.maximum.at(FS[k], F, S[k])
fam_rows = {}
for i, f in enumerate(F): fam_rows.setdefault(f, []).append(i)
def twins(t, exclude=None):
    s = (R[fam_rows[t]] @ R.T).max(0); fs = np.full(NF, -9, np.float32); np.maximum.at(fs, F, s); fs[t] = -9
    if exclude is not None: fs[exclude] = -9
    return set(np.where(fs >= TAU)[0])
top1 = FS.argmax(1) == qf
stats = dict(heldOutTop1Mild=float(top1[lvl == 'mild'].mean()), heldOutTop1Hard=float(top1[lvl == 'hard'].mean()))
wrong = open_false = instant = 0
for k in range(len(q)):
    for openset in (False, True):
        fs = FS[k].copy()
        if openset: fs[qf[k]] = -9
        o = np.argsort(-fs)[:50]; t = o[0]; tw = twins(t, qf[k] if openset else None)
        sec = next((fs[g] for g in o[1:] if g not in tw), -9)
        ok = not tw and fs[t] >= INSTANT_SCORE and fs[t] - sec >= INSTANT_MARGIN
        if not ok: continue
        if openset and qf[k] not in twins(t): open_false += 1
        elif not openset: instant += 1; wrong += int(t != qf[k])
stats.update(instantSingleFrame=instant / len(q), closedWrong=wrong, openSetNonTwinFalse=open_false)
print(json.dumps(stats, indent=1))
if wrong or open_false:
    sys.exit('calibration gate failed: wrong or open-set false locks > 0 — thresholds must be raised')

off = 0
for l, n in zip(LANGS, counts):
    qv = np.clip(np.round(R[off:off + n] * 127), -127, 127).astype(np.int8); off += n
    open(f'{APP}/data/deep-index-{l}.bin.gz', 'wb').write(gzip.compress(qv.tobytes(), 9))
open(f'{APP}/data/deep-model.bin.gz', 'wb').write(gzip.compress(np.concatenate([mu.astype(np.float32).ravel(), M.astype(np.float32).ravel()]).tobytes(), 9))
json.dump({'schema': 'tcg-lens-deep-index-v1', 'backbone': 'mobilenet_v2_alpha0.5_embedding@tfjs-models/mobilenet@2.1.1',
           'deepDims': 1280, 'fastDims': 236, 'inDims': int(M.shape[0]), 'dims': D, 'fastWeight': WF,
           'layout': 'float32 mean[inDims] then float32 M[inDims x dims] row-major; index int8 = round(normalized*127)',
           'training': {'method': 'learned whitening (within-class covariance of simulated camera crops) + PCA', 'regularization': REG, 'trainCrops': len(tm), 'heldOutCrops': len(qm)},
           'calibration': {'twinTau': TAU, 'instantScore': INSTANT_SCORE, 'instantMargin': INSTANT_MARGIN, **stats}},
          open(f'{APP}/data/deep-index.json', 'w'), indent=1)
print('exported', off, 'references')
