import sys, math, subprocess, random
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance
card_path, bg_path, out, w = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
base = Image.open(card_path).convert('RGBA'); h = round(w*base.height/base.width); base = base.resize((w,h), Image.LANCZOS)
bg = Image.open(bg_path).convert('RGB').resize((720,1280))
p = subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s','720x1280','-r','10','-i','-','-pix_fmt','yuv420p',out], stdin=subprocess.PIPE)
rnd = random.Random(1)
for i in range(150):
    card = base.copy(); d = ImageDraw.Draw(card, 'RGBA')
    for _ in range(900):  # holo sparkle over the whole card (cosmos foil + sleeve)
        x, y = rnd.randrange(w), rnd.randrange(h); r = rnd.choice((1,1,2,3))
        d.ellipse((x-r,y-r,x+r,y+r), fill=(rnd.randrange(150,256), rnd.randrange(150,256), rnd.randrange(100,256), rnd.randrange(90,200)))
    gx = int(w*(0.3+0.4*math.sin(i/15)))  # moving glare band
    glare = Image.new('RGBA', card.size, (0,0,0,0)); gd = ImageDraw.Draw(glare)
    gd.polygon([(gx,0),(gx+60,0),(gx-40,h),(gx-100,h)], fill=(255,255,255,90)); card = Image.alpha_composite(card, glare.filter(ImageFilter.GaussianBlur(12)))
    f = bg.copy(); a = 4*math.sin(i/9)
    r = card.rotate(a, expand=True, resample=Image.BICUBIC)
    f.paste(r, (360-r.width//2+int(10*math.sin(i/7)), 620-r.height//2+int(8*math.cos(i/8))), r)
    f = f.filter(ImageFilter.GaussianBlur(0.8 if i%4 else 1.4))
    p.stdin.write(f.tobytes())
p.stdin.close(); p.wait(); print('ok')
