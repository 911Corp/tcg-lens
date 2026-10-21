import json,re,numpy as np, subprocess
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
c=json.load(open('/tmp/claude-0/ui/langcorp/script.json'))
JA=re.compile('[぀-ヿ一-鿿]'); K=re.compile('[぀-ヿ]')
def jc(w): return len([ch for ch in w if JA.match(ch) and ch!='ー'])
def feats(r):
    W=r['jaWords']; jt=r['jaText'].replace('ー','')
    tot=max(1,len(re.sub(r'\s','',jt)))
    lat=re.findall(r'[A-Za-z]{3,}', r['text'])
    return [r['jaStrong'], sum(1 for w,cf in W if cf>=70 and jc(w)>=2), max([cf for w,cf in W if jc(w)>=2] or [0])/100,
            len(K.findall(jt)), len(JA.findall(jt))/tot, r['latinStrong'], len(lat), np.mean([cf for w,cf in W if jc(w)] or [0])/100]
X=np.array([feats(r) for r in c]); y=np.array([r['lang']=='ja' for r in c]); g=np.array([r['id'] for r in c]); v=np.array([r['v'] for r in c])
P=np.zeros(len(y))
for tr,te in GroupKFold(5).split(X,y,g):
    m=LogisticRegression(C=1.0,max_iter=2000,class_weight='balanced').fit(X[tr],y[tr]); P[te]=m.predict_proba(X[te])[:,1]
for th in (0.5,0.8,0.9,0.95,0.98,0.99):
    fp=((P>=th)&~y).sum(); fph=((P>=th)&~y&(v=='holo')).sum(); tp=((P>=th)&y).sum()
    print(th,'false JA on Latin',fp,'/',(~y).sum(),'(holo',fph,') JA recall',tp,'/',y.sum())
m=LogisticRegression(C=1.0,max_iter=2000,class_weight='balanced').fit(X,y); print(np.round(m.coef_,3), m.intercept_)
