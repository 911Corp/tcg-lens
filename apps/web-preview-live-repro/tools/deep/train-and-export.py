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
WF = float(os.environ.get('WF', 0.5)); D = int(os.environ.get('DIMS', 128)); REG = float(os.environ.get('REG', 0.3)); TAU = 0.80
EVAL_ONLY = os.environ.get('EVAL_ONLY') == '1'
INSTANT_SCORE, INSTANT_MARGIN = 0.80, 0.06

nz = lambda X: X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
rows, embs, fasts, keys, counts, sets, files = [], [], [], [], [], [], []
for l in LANGS:
    meta = json.load(open(f'{APP}/data/visual-index-{l}.json'))
    n = meta['count']; ii = meta['columns'].index('id'); counts.append(n)
    embs.append(sum(np.fromfile(f'{WORK}/emb-{l}-{p}.bin', np.float32).reshape(n, 1280) for p in (0, 1)))
    fasts.append(np.fromfile(f'{APP}/data/visual-index-{l}.bin', np.int8).reshape(n, meta['dims']).astype(np.float32) / 127)
    rows += [r[ii] for r in meta['rows']]; keys += [(l, i) for i in range(n)]
    si = meta['columns'].index('setId'); sets += [r[si] for r in meta['rows']]
    pi = meta['columns'].index('imagePath'); files += [r[pi].replace('https://', '').replace('http://', '').replace('/', '_') for r in meta['rows']]
E, FA = nz(np.concatenate(embs)), nz(np.concatenate(fasts))
# Crops are linked to their reference by image file (stable when the index grows), not by row.
fidx = {f: i for i, f in enumerate(files)}
famid = {f: i for i, f in enumerate(dict.fromkeys(rows))}; F = np.array([famid[f] for f in rows]); NF = len(famid)
feat = lambda Dp, Fa: np.concatenate([Dp * (1 - WF) ** .5, Fa * WF ** .5], 1)

def crops(pre, work=WORK):
    m = json.load(open(f'{work}/{pre}meta.json'))
    Q = nz(np.fromfile(f'{work}/{pre}emb.bin', np.float32).reshape(-1, 1280)); QF = nz(np.fromfile(f'{work}/{pre}fast.bin', np.float32).reshape(-1, 236))
    ok = np.linalg.norm(Q, axis=1) > 0.5
    return [x for x, k in zip(m, ok) if k], Q[ok], QF[ok]

tm, TQ, TF = crops('t-'); qm, Q, QF = crops('q-')
# v0.3.8: extra training crop sets (e.g. newly indexed Japanese sets), TRAIN_EXTRA=dir1,dir2.
for extra in filter(None, os.environ.get('TRAIN_EXTRA', '').split(',')):
    m2, Q2, F2 = crops('t-', extra); tm += m2; TQ = np.concatenate([TQ, Q2]); TF = np.concatenate([TF, F2])
# Held-out references never serve for training (crops are linked to their reference image file).
held_files = {m['file'] for m in qm}
keep_t = np.array([m['file'] not in held_files for m in tm])
tm = [m for m, k in zip(tm, keep_t) if k]; TQ, TF = TQ[keep_t], TF[keep_t]
R0, T0, Q0 = feat(E, FA), feat(TQ, TF), feat(Q, QF)
keep = np.array([m['file'] in fidx for m in tm])
tm = [m for m, k in zip(tm, keep) if k]; T0 = T0[keep]
diff = T0 - R0[np.array([fidx[m['file']] for m in tm])]
mu = R0.mean(0); Cw = diff.T @ diff / len(diff)
w, V = np.linalg.eigh(Cw + REG * np.trace(Cw) / Cw.shape[0] * np.eye(Cw.shape[0]))
P = V / np.sqrt(w)
Rw = (R0 - mu) @ P
_, _, Vt = np.linalg.svd(Rw - Rw.mean(0), full_matrices=False)
M = P @ Vt[:D].T
if os.environ.get('USE_DEPLOYED') == '1':  # re-calibrate / re-export the deployed projection on the grown index
    _o = json.load(open(f'{APP}/data/deep-index.json')); _f = np.frombuffer(gzip.decompress(open(f'{APP}/data/deep-model.bin.gz', 'rb').read()), np.float32)
    mu, M = _f[:_o['inDims']].astype(np.float64), _f[_o['inDims']:].reshape(_o['inDims'], _o['dims']).astype(np.float64)
proj = lambda X: nz((X - mu) @ M)
R, q = proj(R0).astype(np.float32), proj(Q0)

# Held-out calibration (closed set + open set, twin-aware margin).
qf = np.array([famid[m['id']] for m in qm]); lvl = np.array([m['level'] for m in qm])
def family_scores(qv, Rv):
    # Chunked (index × held-out crops would not fit in memory as one matrix).
    out = np.full((len(qv), NF), -9, np.float32); Rv = Rv.astype(np.float32)
    order = np.argsort(F, kind='stable'); starts = np.r_[0, np.flatnonzero(np.diff(F[order])) + 1]
    for a in range(0, len(qv), 256):
        Sb = qv[a:a + 256].astype(np.float32) @ Rv.T
        out[a:a + 256] = np.maximum.reduceat(Sb[:, order], starts, axis=1)
    return out
FS = family_scores(q, R)
fam_rows = {}
for i, f in enumerate(F): fam_rows.setdefault(f, []).append(i)
def twins(t, exclude=None):
    s = (R[fam_rows[t]] @ R.T).max(0); fs = np.full(NF, -9, np.float32); np.maximum.at(fs, F, s); fs[t] = -9
    if exclude is not None: fs[exclude] = -9
    return set(np.where(fs >= TAU)[0])
top1 = FS.argmax(1) == qf
stats = {f'heldOutTop1_{L}': round(float(top1[lvl == L].mean()), 4) for L in sorted(set(lvl))}
qset = np.array([m.get('set') for m in qm]); focus = np.array([bool(m.get('focus')) for m in qm])
for sname in sorted(set(qset[focus])):
    sel = qset == sname
    stats[f'top1_{sname}'] = {L: round(float(top1[sel & (lvl == L)].mean()), 3) for L in sorted(set(lvl[sel]))}
# Same held-out crops through the currently deployed projection (regression check).
try:
    old = json.load(open(f'{APP}/data/deep-index.json'))
    if old['inDims'] == M.shape[0]:
        f = np.frombuffer(gzip.decompress(open(f'{APP}/data/deep-model.bin.gz', 'rb').read()), np.float32)
        omu, oM = f[:old['inDims']], f[old['inDims']:].reshape(old['inDims'], old['dims'])
        oR, oq = nz((R0 - omu) @ oM), nz((Q0 - omu) @ oM)
        oFS = family_scores(oq, oR)
        ot = oFS.argmax(1) == qf
        stats['deployedModelTop1'] = {L: round(float(ot[lvl == L].mean()), 4) for L in sorted(set(lvl))}
        for sname in sorted(set(qset[focus])):
            sel = qset == sname; stats[f'deployed_{sname}'] = {L: round(float(ot[sel & (lvl == L)].mean()), 3) for L in sorted(set(lvl[sel]))}
except FileNotFoundError: pass
# Candidate decisions for every held-out crop (closed set and open set = true family removed).
cases = []  # (open, score, nonTwinMargin, twinFree, correct, trueIsTwinOfTop)
for k in range(len(q)):
    for openset in (False, True):
        fs = FS[k].copy()
        if openset: fs[qf[k]] = -9
        o = np.argsort(-fs)[:50]; t = o[0]; tw = twins(t, qf[k] if openset else None)
        sec = next((fs[g] for g in o[1:] if g not in tw), -9)
        cases.append((openset, float(fs[t]), float(fs[t] - sec), not tw, t == qf[k], openset and qf[k] in twins(t)))
C = np.array([(c[0], c[1], c[2], c[3], c[4], c[5]) for c in cases], dtype=object)
op = C[:, 0].astype(bool); sc = C[:, 1].astype(float); mg = C[:, 2].astype(float); tf = C[:, 3].astype(bool); co = C[:, 4].astype(bool); tt = C[:, 5].astype(bool)
def outcome(T, Mg):
    acc = tf & (sc >= T) & (mg >= Mg)
    return int((acc & ~op & ~co).sum()), int((acc & op & ~tt).sum()), float((acc & ~op & co).sum() / max(1, (~op).sum()))
# Most permissive thresholds with zero wrong / zero open-set non-twin false locks, also holding with a
# safety margin (T - 0.02, M - 0.01) so the bars do not sit on the edge of a failure.
best = None
for T in np.arange(0.76, 0.95, 0.01):
    for Mg in np.arange(0.04, 0.16, 0.01):
        w1, o1, a1 = outcome(T, Mg); w2, o2, _ = outcome(T - 0.02, Mg - 0.01)
        if w1 or o1 or w2 or o2: continue
        if best is None or a1 > best[2]: best = (round(float(T), 2), round(float(Mg), 2), a1)
if best is None: sys.exit('calibration gate failed: no threshold pair gives zero wrong and zero open-set false locks')
INSTANT_SCORE, INSTANT_MARGIN = best[0], best[1]
wrong, open_false, rate = outcome(INSTANT_SCORE, INSTANT_MARGIN)
instant = rate
# Visual script proof (Latin vs Japanese printings sharing the artwork): smallest gap between the top
# family and its best other-script family with zero errors at gap and gap - 0.01 (safety margin).
langs_arr = np.array([k[0] for k in keys]); fam_script = np.zeros(NF, int)
for i, fi in enumerate(F): fam_script[fi] = 1 if langs_arr[i] == 'ja' else 0
gaps = []
for k, m in enumerate(qm):
    t = FS[k].argmax(); other = FS[k].copy(); other[fam_script == fam_script[t]] = -9; o = other.argmax()
    if FS[k][o] >= TAU: gaps.append((FS[k][t] - FS[k][o], fam_script[t] == (1 if m['lang'] == 'ja' else 0)))
G = np.array(gaps, dtype=float) if gaps else np.zeros((0, 2))
SCRIPT_GAP = next((round(float(g), 2) for g in np.arange(0.02, 0.2, 0.01)
                   if len(G) and not ((G[:, 0] >= g - 0.01) & (G[:, 1] == 0)).any()), None)
stats.update(scriptGap=SCRIPT_GAP, scriptGapDecided=round(float((G[:, 0] >= SCRIPT_GAP).mean()), 3) if SCRIPT_GAP and len(G) else 0, scriptCases=len(G))
stats.update(instantScore=INSTANT_SCORE, instantMargin=INSTANT_MARGIN, instantSingleFrame=round(instant, 4), closedWrong=wrong, openSetNonTwinFalse=open_false)
print(json.dumps(stats, indent=1))
if wrong or open_false:
    sys.exit('calibration gate failed: wrong or open-set false locks > 0 — thresholds must be raised')
if EVAL_ONLY: sys.exit(0)

off = 0
for l, n in zip(LANGS, counts):
    qv = np.clip(np.round(R[off:off + n] * 127), -127, 127).astype(np.int8); off += n
    open(f'{APP}/data/deep-index-{l}.bin.gz', 'wb').write(gzip.compress(qv.tobytes(), 9))
open(f'{APP}/data/deep-model.bin.gz', 'wb').write(gzip.compress(np.concatenate([mu.astype(np.float32).ravel(), M.astype(np.float32).ravel()]).tobytes(), 9))
json.dump({'schema': 'tcg-lens-deep-index-v1', 'backbone': 'mobilenet_v2_alpha0.5_embedding@tfjs-models/mobilenet@2.1.1',
           'deepDims': 1280, 'fastDims': 236, 'inDims': int(M.shape[0]), 'dims': D, 'fastWeight': WF,
           'layout': 'float32 mean[inDims] then float32 M[inDims x dims] row-major; index int8 = round(normalized*127)',
           'training': {'method': 'learned whitening (within-class covariance of simulated camera crops) + PCA', 'regularization': REG, 'trainCrops': len(tm), 'heldOutCrops': len(qm)},
           'calibration': {'twinTau': TAU, **stats}},
          open(f'{APP}/data/deep-index.json', 'w'), indent=1)
print('exported', off, 'references')
