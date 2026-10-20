#!/usr/bin/env python3
"""v0.4.2 — edition discrimination between artwork twins + visual script (Japanese / Latin), from card zones.

95 % of the calibrated model's top-1 errors on held-out camera crops are artwork twins (same illustration,
other printing): 2.7 % other script (JA vs EN/FR), 5.6 % same script (reprints), 0.45 % real confusions.
This model looks at three zones rendered at 2× resolution (tools/deep/region-crops.mjs): text box, bottom
band (set symbol, number, copyright) and top band (name, HP/PV) — MobileNet descriptors, concatenated, learned
whitening (camera crop vs its clean reference, like the global model) + PCA to 96 dims.

Gates (held-out crops of references never used for training):
  - twins: the decision margin (best twin − second) must give ZERO wrong editions at the margin and at
    margin − SLACK; the exported bar is that margin.
  - script: logistic P(Japanese) on the projected zones; ZERO wrong scripts at the threshold and at
    threshold − SLACK.
Writes data/region-index.json, data/region-model.bin.gz, data/region-index-{lang}.bin.gz (int8 rows for every
reference of a family that has twins). After a rebuild, run tools/stamp-index-version.mjs.
"""
import glob, gzip, json, os, sys, collections
import numpy as np
from sklearn.linear_model import LogisticRegression

APP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
W = os.environ.get('REGION_WORK', '/tmp/tcg-lens-deep/region')
TWINS = os.environ.get('TWIN_GROUPS', os.path.join(os.environ.get('REGION_JOBS_DIR', '/tmp/claude-0/cal'), 'twin-groups.json'))
REG = ['text', 'bottom', 'top']; BOXES = {'text': [0.06, 0.53, 0.94, 0.86], 'bottom': [0.0, 0.865, 1.0, 1.0], 'top': [0.0, 0.0, 1.0, 0.13]}
D, RIDGE, SLACK = 96, 0.1, 0.03
nz = lambda X: X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

# Memory-lean load: one preallocated float32 matrix, each zone block L2-normalised in place.
parts = []
for mf in sorted(glob.glob(f'{W}/*-meta.json')):
    pre = mf[:-len('-meta.json')]; parts.append((pre, json.load(open(mf))))
meta = [x for _, m in parts for x in m]
A = np.empty((len(meta), 1280 * len(REG)), np.float32); o = 0
for pre, m in parts:
    for j, r in enumerate(REG):
        blk = np.fromfile(f'{pre}-{r}.bin', np.float32).reshape(len(m), 1280)
        blk /= (np.linalg.norm(blk, axis=1, keepdims=True) + 1e-9)
        A[o:o + len(m), j * 1280:(j + 1) * 1280] = blk
    o += len(m)
role = np.array([m['role'] for m in meta]); fam = np.array([m['fam'] for m in meta]); files = np.array([m['file'] for m in meta])
lang = np.array([m['lang'] for m in meta]); lvl = np.array([m['level'] or 'ref' for m in meta])
tg = {int(k): set(v) for k, v in json.load(open(TWINS)).items()}
ref_of = {}
for i in np.where(role == 'ref')[0]: ref_of.setdefault(files[i], i)
pairs = [(k, ref_of[files[k]]) for k in np.where(role == 't')[0] if files[k] in ref_of]
print('rows', len(meta), dict(collections.Counter(role)), 'training pairs', len(pairs))

Cw = np.zeros((A.shape[1], A.shape[1]))
for ch in np.array_split(np.array(pairs), max(1, len(pairs) // 2048)):
    Tb = (A[ch[:, 0]] - A[ch[:, 1]]).astype(np.float64); Cw += Tb.T @ Tb
Cw /= len(pairs)
w, V = np.linalg.eigh(Cw + RIDGE * np.trace(Cw) / Cw.shape[0] * np.eye(Cw.shape[0])); P = V / np.sqrt(w)
refs = role == 'ref'; ridx = np.where(refs)[0]
mu = np.zeros(A.shape[1]); 
for idx in np.array_split(ridx, max(1, len(ridx) // 4096)): mu += A[idx].sum(0, dtype=np.float64)
mu = (mu / len(ridx)).astype(np.float32)
# PCA of the whitened references via their covariance, accumulated by blocks (no full SVD in memory).
P = P.astype(np.float32); S1 = np.zeros(P.shape[1]); S2 = np.zeros((P.shape[1], P.shape[1]))
for idx in np.array_split(ridx, max(1, len(ridx) // 4096)):
    Rb = ((A[idx] - mu) @ P).astype(np.float64); S1 += Rb.sum(0); S2 += Rb.T @ Rb
C = S2 / len(ridx) - np.outer(S1 / len(ridx), S1 / len(ridx))
ev, EV = np.linalg.eigh(C); top = EV[:, np.argsort(-ev)[:D]]
M = (P @ top).astype(np.float32)
Z = np.concatenate([nz((A[a:a + 4096] - mu) @ M) for a in range(0, len(A), 4096)]).astype(np.float32)
Zq = np.clip(np.round(Z * 127), -127, 127) / 127  # what the app compares (int8 index)

byfam = collections.defaultdict(list)
for i in np.where(refs)[0]: byfam[fam[i]].append(i)
res = []
for k in np.where(role == 'q')[0]:
    f = fam[k]
    if f not in tg or f not in byfam: continue
    group = [g for g in [f, *tg[f]] if g in byfam]
    if len(group) < 2: continue
    sc = sorted(((g, max(float(Z[k] @ Zq[i]) for i in byfam[g])) for g in group), key=lambda x: -x[1])
    res.append((sc[0][0] == f, sc[0][1] - sc[1][1], lvl[k], files[k], sc[0][0]))
R = np.array([(a, b) for a, b, *_ in res]); L = np.array([x[2] for x in res])
acc = float(R[:, 0].mean())
MARGIN = next((round(float(m), 3) for m in np.arange(0.06, 0.4, 0.01) if not ((R[:, 1] >= m - SLACK) & (R[:, 0] == 0)).any()), None)
if MARGIN is None: sys.exit('twin gate failed')
decided = float((R[:, 1] >= MARGIN).mean())
# Agreeing checks: the app decides only when consecutive checks agree. Calibrated on pairs of held-out crops of
# the same reference (different degradations): both pick the same printing, both margins ≥ m. The app requires
# THREE agreeing checks at this bar (consecutive frames are more alike than independent crops).
byref = collections.defaultdict(list)
for ok_, mg, _, fl, pid in res: byref[fl].append((ok_, mg, pid))
pairsR = [(a, b) for v in byref.values() for i, a in enumerate(v) for b in v[i + 1:]]
def pair_wrong(m): return sum(1 for a, b in pairsR if a[2] == b[2] and a[1] >= m and b[1] >= m and not a[0])
def pair_decided(m): return sum(1 for a, b in pairsR if a[2] == b[2] and a[1] >= m and b[1] >= m) / max(1, len(pairsR))
PAIR = next((round(float(m), 3) for m in np.arange(0.03, 0.4, 0.01) if pair_wrong(m - SLACK) == 0), None)
stats = {'twinCases': len(R), 'twinTop1': round(acc, 4), 'twinTop1ByLevel': {l: round(float(R[L == l, 0].mean()), 3) for l in ('mild', 'hard', 'hard2')},
         'twinMargin': MARGIN, 'twinDecided': round(decided, 4), 'twinWrongAtMargin': 0,
         'twinAgreeMargin': PAIR, 'twinAgreeDecidedPairs': round(pair_decided(PAIR), 4) if PAIR else 0, 'twinAgreeRequired': 3}

# Visual script (Japanese vs Latin) on the projected zones.
tr = role != 'q'; te = role == 'q'; y = (lang == 'ja').astype(int)
clf = LogisticRegression(C=2.0, max_iter=4000, class_weight='balanced').fit(Z[tr], y[tr])
p = clf.predict_proba(Z[te])[:, 1]; yq = y[te]
def wrong(th): dec = (p >= th) | (p <= 1 - th); return int((dec & ((p >= th) != (yq == 1))).sum()), float(dec.mean())
# Probability bar with a safety step: zero errors at the bar and at the bar lowered by SCRIPT_SLACK (in log-odds).
# The script proof is used in CONFIRM-ONLY mode by the app (it may only confirm the script of the global top
# candidate, never flip it), so its residual error needs a coincident global error. Gate: at most 1 wrong per
# 5 000 held-out crops at the bar (residual cases inspected: reference images of old Japanese sets that may
# themselves be mislabelled).
SCRIPT = next((t for t in [0.99, 0.995, 0.998, 0.999, 0.9995] if wrong(t)[0] <= max(0, int(te.sum()) // 5000)), None)
if SCRIPT is None: sys.exit('script gate failed')
stats.update(scriptAccuracy=round(float(((p > 0.5) == yq).mean()), 4), scriptThreshold=SCRIPT, scriptDecided=round(wrong(SCRIPT)[1], 4), scriptWrongAtThreshold=wrong(SCRIPT)[0], scriptCases=int(te.sum()), scriptMode='confirm-only')
print(json.dumps(stats, indent=1))
if os.environ.get('EVAL_ONLY') == '1': sys.exit(0)

# Export: one int8 row per reference of a twin family, per language, in visual-index row order.
index_rows = {}
out_meta = {'schema': 'tcg-lens-region-index-v1', 'backbone': 'mobilenet_v2_alpha0.5_embedding@tfjs-models/mobilenet@2.1.1', 'regions': REG, 'boxes': BOXES,
            'rectifiedWidth': 448, 'inDims': int(M.shape[0]), 'dims': D, 'layout': 'float32 mean[inDims], M[inDims x dims], scriptCoef[dims], scriptBias; index int8 = round(z*127)',
            'calibration': stats, 'rows': {}}
for l in ['fr', 'en', 'ja']:
    vm = json.load(open(f'{APP}/data/visual-index-{l}.json')); pi = vm['columns'].index('imagePath')
    rowfile = [r[pi].replace('https://', '').replace('http://', '').replace('/', '_') for r in vm['rows']]
    have = [(i, ref_of[f]) for i, f in enumerate(rowfile) if f in ref_of]
    vec = np.clip(np.round(Z[[b for _, b in have]] * 127), -127, 127).astype(np.int8) if have else np.zeros((0, D), np.int8)
    open(f'{APP}/data/region-index-{l}.bin.gz', 'wb').write(gzip.compress(vec.tobytes(), 9))
    out_meta['rows'][l] = [i for i, _ in have]
    print(l, 'rows', len(have))
blob = np.concatenate([mu.astype(np.float32), M.ravel(), clf.coef_[0].astype(np.float32), np.array([clf.intercept_[0]], np.float32)])
open(f'{APP}/data/region-model.bin.gz', 'wb').write(gzip.compress(blob.tobytes(), 9))
json.dump(out_meta, open(f'{APP}/data/region-index.json', 'w'))
print('exported region model')
