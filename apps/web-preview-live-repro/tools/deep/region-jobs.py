#!/usr/bin/env python3
"""v0.4.2 — artwork-twin groups (reference similarity ≥ 0.8 in the calibrated index) and region-crops jobs.

Writes $REGION_JOBS_DIR/twin-groups.json and region-jobs.json (held-out q, training t, clean references of every
twin family). Then: node tools/deep/region-crops.mjs <jobs> <prefix> [part parts]; python3 tools/deep/train-regions.py."""
import json, gzip, numpy as np, collections, random
import os
APP=os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')); OUT=os.environ.get('REGION_JOBS_DIR', '/tmp/claude-0/cal')
rows=[]; langs=[]; files=[]; R=[]; sets=[]
for l in ['fr','en','ja']:
    m=json.load(open(f'{APP}/data/visual-index-{l}.json')); c={k:i for i,k in enumerate(m['columns'])}
    for r in m['rows']: rows.append(r[c['id']]); langs.append(l); files.append(r[c['imagePath']].replace('https://','').replace('http://','').replace('/','_')); sets.append(r[c['setId']])
    R.append(np.frombuffer(gzip.decompress(open(f'{APP}/data/deep-index-{l}.bin.gz','rb').read()),np.int8).reshape(m['count'],-1).astype(np.float32)/127)
R=np.concatenate(R); fam={f:i for i,f in enumerate(dict.fromkeys(rows))}; F=np.array([fam[f] for f in rows]); NF=len(fam)
order=np.argsort(F,kind='stable'); starts=np.r_[0,np.flatnonzero(np.diff(F[order]))+1]
# twin groups: families whose references are ≥ 0.8 similar to another family's
twin_of=collections.defaultdict(set)
for a in range(0,len(R),2048):
    S=(R[a:a+2048]@R.T); S[S<0.8]=0
    for i,j in zip(*np.nonzero(S)):
        fi,fj=F[a+i],F[j]
        if fi!=fj: twin_of[fi].add(fj)
twin_fams=set(twin_of)
print('families',NF,'with twins',len(twin_fams), 'refs in twin families', int(np.isin(F,list(twin_fams)).sum()))
random.seed(7)
idx=list(range(len(rows))); random.shuffle(idx)
# held-out refs for evaluation: by file; script set balanced
ja=[i for i in idx if langs[i]=='ja']; la=[i for i in idx if langs[i]!='ja']
held=set(ja[:500]+la[:500])
# twin evaluation: 700 refs of twin families held out
tw=[i for i in idx if F[i] in twin_fams and i not in held][:900]
held|=set(tw)
jobs=[]
def add(i,role,levels): jobs.append({'file':files[i],'id':rows[i],'fam':int(F[i]),'lang':langs[i],'set':sets[i],'role':role,'levels':levels})
for i in sorted(held): add(i,'q',['mild','hard','hard2'])
train=[i for i in ja[500:3500]]+[i for i in la[500:3500]]+[i for i in idx if F[i] in twin_fams and i not in held][:4000]
for i in dict.fromkeys(train): add(i,'t',['hard','hard2'])
# clean references for every twin-family row (edition comparison needs them)
for i in range(len(rows)):
    if F[i] in twin_fams: add(i,'ref',[])
json.dump(jobs,open(f'{OUT}/region-jobs.json','w'))
json.dump({str(k):sorted(int(x) for x in v) for k,v in twin_of.items()},open(f'{OUT}/twin-groups.json','w'))
c=collections.Counter(j['role'] for j in jobs); print(c, 'model passes ≈', 3*(c['ref']+3*c['q']+2*c['t']))
