import os, sys, io, json, subprocess, random
from multiprocessing import Pool
from PIL import Image, ImageFilter, ImageEnhance, ImageOps
D='/tmp/claude-0/ui/langcorp'
SUB=sys.argv[1] if len(sys.argv)>1 else 'img'
OUT=sys.argv[2] if len(sys.argv)>2 else 'ocr.json'
def zone(im, y, h):
    W,H=im.size; z=im.crop((0,int(H*y),W,int(H*(y+h)))).resize((900,250), Image.BICUBIC)
    z=ImageOps.grayscale(z); z=ImageEnhance.Contrast(z).enhance(1.55); return z
def ocr(z):
    b=io.BytesIO(); z.save(b,'PNG')
    r=subprocess.run(['tesseract','stdin','stdout','--psm','6','-l','eng','tsv'],input=b.getvalue(),capture_output=True,env={**os.environ,'OMP_THREAD_LIMIT':'1'})
    words=[]
    for line in r.stdout.decode('utf8','ignore').splitlines()[1:]:
        p=line.split('\t')
        if len(p)==12 and p[11].strip(): words.append((p[11], float(p[10])))
    return words
def job(fn):
    lang,cid=fn[:-5].split('__',1)
    try: im=Image.open(f'{D}/{SUB}/{fn}').convert('RGB')
    except Exception: return None
    g=ImageOps.grayscale(im).point(lambda p: 255 if p<235 else 0); bb=g.getbbox()
    if bb and (bb[2]-bb[0])*(bb[3]-bb[1]) < 0.9*im.width*im.height: im=im.crop(bb)
    rnd=random.Random(fn); res=[]
    for v,(w,bl,q) in enumerate([(480,0.7,60),(360,1.2,40)]):
        x=im.resize((w,round(w*im.height/im.width)),Image.LANCZOS).filter(ImageFilter.GaussianBlur(bl))
        x=ImageEnhance.Brightness(x).enhance(rnd.uniform(0.8,1.2))
        b=io.BytesIO(); x.save(b,'JPEG',quality=q); x=Image.open(b).convert('RGB')
        t=ocr(zone(x,0,0.32)); bo=ocr(zone(x,0.69,0.31))
        strong=sum(1 for wd,c in t+bo if c>=80 and len(wd)>=3 and all(ch.isalpha() or ch in "'’-" for ch in wd))
        res.append({'lang':lang,'id':cid,'v':v,'text':' '.join(wd for wd,_ in t)+' '+' '.join(wd for wd,_ in bo),'latinStrong':strong})
    return res
if __name__=='__main__':
    fs=sorted(os.listdir(f'{D}/{SUB}'))
    with Pool(8) as p: out=[r for rs in p.imap_unordered(job,fs) if rs for r in rs]
    json.dump(out,open(f'{D}/{OUT}','w'),ensure_ascii=False); print(len(out))
