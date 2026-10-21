import sys, math, subprocess
from PIL import Image, ImageFilter
card_path, bg_path, out, w = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv)>4 else 500
card = Image.open(card_path).convert('RGBA'); h = round(w*card.height/card.width)
card = card.resize((w,h), Image.LANCZOS)
bg = Image.open(bg_path).convert('RGB').resize((720,1280))
p = subprocess.Popen(['ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s','720x1280','-r','10','-i','-','-pix_fmt','yuv420p',out], stdin=subprocess.PIPE)
for i in range(120):
    f = bg.copy(); a = 2.5*math.sin(i/9); r = card.rotate(a, expand=True, resample=Image.BICUBIC)
    x = 360 - r.width//2 + int(8*math.sin(i/7)); y = 600 - r.height//2 + int(6*math.cos(i/8))
    f.paste(r, (x,y), r)
    if i % 5 == 0: f = f.filter(ImageFilter.GaussianBlur(0.6))
    p.stdin.write(f.tobytes())
p.stdin.close(); p.wait(); print('ok', out)
