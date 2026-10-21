import os, sys, io, json, subprocess, random
from multiprocessing import Pool
from PIL import Image, ImageFilter, ImageEnhance, ImageOps, ImageDraw
D='/tmp/claude-0/ui/langcorp'; TD='/tmp/claude-0/ui/tessdata'
def zone(im, y, h):
    W,H=im.size; z=im.crop((0,int(H*y),W,int(H*(y+h)))).resize((900,250), Image.BICUBIC)
    return ImageEnhance.Contrast(ImageOps.grayscale(z)).enhance(1.55)
def ocr(z, lang):
    b=io.BytesIO(); z.save(b,'PNG')
    r=subprocess.run(['tesseract','stdin','stdout','--tessdata-dir',TD,'--psm','6','-l',lang,'tsv'],input=b.getvalue(),capture_output=True,env={**os.environ,'OMP_THREAD_LIMIT':'1'})
    out=[]
    for line in r.stdout.decode('utf8','ignore').splitlines()[1:]:
        p=line.split('\t')
        if len(p)==12 and p[11].strip(): out.append((p[11], float(p[10])))
    return out
def holo(im, rnd):
    im=im.convert('RGBA'); w,h=im.size; d=ImageDraw.Draw(im,'RGBA')
    for _ in range(int(900*w*h/(420*578))):
        x,y=rnd.randrange(w),rnd.randrange(h); r=rnd.choice((1,1,2,3))
        d.ellipse((x-r,y-r,x+r,y+r),fill=(rnd.randrange(150,256),rnd.randrange(150,256),rnd.randrange(100,256),rnd.randrange(90,200)))
    return im.convert('RGB').filter(ImageFilter.GaussianBlur(1.0))
import re
JA=re.compile('[぀-ヿ一-鿿]')
def job(path):
    sub,fn=path; lang,cid=fn[:-5].split('__',1)
    try: im=Image.open(f'{D}/{sub}/{fn}').convert('RGB')
    except Exception: return None
    g=ImageOps.grayscale(im).point(lambda p: 255 if p<235 else 0); bb=g.getbbox()
    if bb and (bb[2]-bb[0])*(bb[3]-bb[1]) < 0.9*im.width*im.height: im=im.crop(bb)
    rnd=random.Random(fn); res=[]
    for v in ('mild','holo'):
        x=im.resize((480,round(480*im.height/im.width)),Image.LANCZOS)
        x=x.filter(ImageFilter.GaussianBlur(0.7)) if v=='mild' else holo(x,rnd)
        b=io.BytesIO(); x.save(b,'JPEG',quality=60); x=Image.open(b).convert('RGB')
        top=zone(x,0,0.32); t=ocr(top,'eng'); bo=ocr(zone(x,0.69,0.31),'eng'); j=ocr(top,'jpn')
        strong=sum(1 for wd,c in t+bo if c>=80 and len(wd)>=3 and all(ch.isalpha() or ch in "'’-" for ch in wd))
        jaStrong=sum(len([ch for ch in wd if JA.match(ch) and ch!='ー']) for wd,c in j if c>=75)
        res.append({'lang':lang,'id':cid,'v':v,'text':' '.join(w for w,_ in t)+' '+' '.join(w for w,_ in bo),'latinStrong':strong,'jaText':''.join(w for w,_ in j),'jaStrong':jaStrong,'jaWords':[(w,round(c)) for w,c in j][:60]})
    return res
if __name__=='__main__':
    recent=re.compile(r'__(sv|swsh|sm|me|xy|svp|swshp|cel|30th)')
    lat=[('img',f) for f in sorted(os.listdir(f'{D}/img')) if recent.search(f)]
    ja=[('imgja',f) for f in sorted(os.listdir(f'{D}/imgja'))][:160]
    with Pool(2) as p: out=[r for rs in p.imap_unordered(job,lat+ja) if rs for r in rs]
    json.dump(out,open(f'{D}/script.json','w'),ensure_ascii=False); print(len(out))
