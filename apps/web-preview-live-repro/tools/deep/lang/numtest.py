import os, io, json, re, subprocess, random, sys
from multiprocessing import Pool
from PIL import Image, ImageFilter, ImageEnhance, ImageOps
D='/tmp/claude-0/ui/langcorp/img'; A='/home/claude/tcg-lens/apps/web-preview-live-repro/data/'
truth={}
for l in ('fr','en'):
    d=json.load(open(f'{A}visual-index-{l}.json')); c=d['columns']
    for r in d['rows']:
        r=dict(zip(c,r)); truth[(l,r['id'])]=(r['localId'],r['printedTotal'],r['printedNumber'])
def tess(img, psm, wl=True):
    b=io.BytesIO(); img.save(b,'PNG')
    args=['tesseract','stdin','stdout','--psm',str(psm),'-l','eng']+(['-c','tessedit_char_whitelist=0123456789/'] if wl else [])
    return subprocess.run(args,input=b.getvalue(),capture_output=True,env={**os.environ,'OMP_THREAD_LIMIT':'1'}).stdout.decode('utf8','ignore')
def zone(im,x,y,w,h,ow,oh,mode):
    W,H=im.size; z=im.crop((int(W*x),int(H*y),int(W*(x+w)),int(H*(y+h)))).resize((ow,oh),Image.BICUBIC)
    z=ImageEnhance.Contrast(ImageOps.grayscale(z)).enhance(1.55)
    if mode=='bin':
        z=ImageOps.autocontrast(z,cutoff=2)
    return z
def plaus(t):
    m=re.match(r'^(\d{1,4})/(\d{2,4})$',t); 
    if not m: return False
    n,T=int(m[1]),int(m[2]); return n>=1 and 10<=T<=400 and n<=T+150
VARIANTS={
 'app':     lambda im: [zone(im,0,0.9,0.5,0.1,960,192,''),zone(im,0.5,0.9,0.5,0.1,960,192,'')],
 'tall':    lambda im: [zone(im,0,0.88,0.5,0.12,960,230,''),zone(im,0.5,0.88,0.5,0.12,960,230,'')],
 'auto':    lambda im: [zone(im,0,0.9,0.5,0.1,960,192,'bin'),zone(im,0.5,0.9,0.5,0.1,960,192,'bin')],
 'tallauto':lambda im: [zone(im,0,0.88,0.5,0.12,1200,288,'bin'),zone(im,0.5,0.88,0.5,0.12,1200,288,'bin')],
}
def job(fn):
    lang,cid=fn[:-5].split('__',1); tr=truth.get((lang,cid))
    if not tr or not tr[1] or not re.match(r'^\d+$',str(tr[0])): return None
    im=Image.open(f'{D}/{fn}').convert('RGB'); rnd=random.Random(fn)
    x=im.resize((int(os.environ.get("CW","480")),round(int(os.environ.get("CW","480"))*im.height/im.width)),Image.LANCZOS).filter(ImageFilter.GaussianBlur(float(os.environ.get("BL","0.8"))))
    b=io.BytesIO(); x.save(b,'JPEG',quality=55); x=Image.open(b).convert('RGB')
    out={'truth':[str(tr[0]),int(tr[1])]}
    for name,f in VARIANTS.items():
        reads=[re.sub(r'\s+','',tess(z,11)) for z in f(x)]
        out[name+'_raw']=reads
        found=[t for r in reads for t in re.findall(r'\d{1,4}/\d{2,4}',r) if plaus(t)]
        ok=any(int(t.split('/')[0])==int(tr[0]) and int(t.split('/')[1])==int(tr[1]) for t in found)
        wrong=any(not(int(t.split('/')[0])==int(tr[0]) and int(t.split('/')[1])==int(tr[1])) for t in found)
        out[name]=(ok,wrong)
    return out
if __name__=='__main__':
    fs=[f for f in sorted(os.listdir(D)) if re.search(r'__(sv|swsh|sm|me|30th|svp)',f)][:int(sys.argv[1])]
    with Pool(2) as p: R=[r for r in p.map(job,fs) if r]
    import json as _j
    _j.dump([{'truth':r['truth'],'app':r['app_raw'],'auto':r['auto_raw']} for r in R],open('/tmp/claude-0/s/numreads.json','w'))
    for name in VARIANTS: print(name,len(R),'right',sum(r[name][0] for r in R),'wrong-read',sum(r[name][1] for r in R))
