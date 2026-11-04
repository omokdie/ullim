"""시험 · 화면 캡처용 가짜 음악 라이브러리 만들기 (장르 · 앨범 · 앨범아트가 있는 짧은 곡들)
   python3 test/make_library.py [/tmp/ullim-lib]
   곡 이름은 지어낸 것이고, 소리는 몇 초짜리 사인파예요. 앨범아트는 그라데이션 + 도형으로 그립니다."""
import os, subprocess, sys, json, math, random
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ullim-lib'
os.makedirs(OUT, exist_ok=True)

# (제목, 가수, 앨범, 장르, 형식, 색1, 색2, 모양)
SONGS = [
    ('새벽 세 시의 편지', '하늘빛', '밤의 정원', '발라드', 'mp3', '#3b2f8f', '#e86f9a', 'moon'),
    ('너에게 닿기를', '하늘빛', '밤의 정원', '발라드', 'mp3', '#3b2f8f', '#e86f9a', 'moon'),
    ('창문 너머 봄', '윤슬', '봄날의 기록', '발라드', 'm4a', '#ff9a8b', '#ffe29f', 'circle'),
    ('조각난 계절', '윤슬', '봄날의 기록', '발라드', 'flac', '#ff9a8b', '#ffe29f', 'circle'),
    ('Neon Runner', 'PRISM', 'Afterglow', 'Dance', 'mp3', '#0f2027', '#2cf6b3', 'bars'),
    ('Heartbeat 120', 'PRISM', 'Afterglow', 'Dance', 'm4a', '#0f2027', '#2cf6b3', 'bars'),
    ('불꽃놀이', '라임스', 'SPARK', '댄스', 'mp3', '#f12711', '#f5af19', 'star'),
    ('Midnight Drive', 'Lowkey', 'Cruise', '랩/힙합', 'mp3', '#141e30', '#e3a51a', 'grid'),
    ('도시의 밤', 'Lowkey', 'Cruise', 'Hip-Hop', 'flac', '#141e30', '#e3a51a', 'grid'),
    ('Rooftop', '모노톤', 'Grey Area', 'R&B', 'm4a', '#232526', '#a18cd1', 'wave'),
    ('파도 소리', '바다새', '섬', '인디', 'opus', '#2193b0', '#6dd5ed', 'wave'),
    ('작은 방', '바다새', '섬', '인디', 'mp3', '#2193b0', '#6dd5ed', 'wave'),
    ('Thunder Road', 'IRONLEAF', 'Steel', 'Rock', 'mp3', '#3a1c71', '#d76d77', 'bolt'),
    ('녹슨 기타', 'IRONLEAF', 'Steel', '록', 'flac', '#3a1c71', '#d76d77', 'bolt'),
    ('고향역', '진달래', '트로트 메들리', '트로트', 'mp3', '#c31432', '#f7b733', 'circle'),
    ('Cafe Window', 'Mellow Cat', 'Lo-fi Days', 'Lo-Fi', 'm4a', '#614385', '#f0c27b', 'grid'),
    ('빗소리 재즈', 'Blue Note Club', 'Rainy', 'Jazz', 'mp3', '#16222a', '#3a6073', 'moon'),
    ('이름 없는 노래', '', '', '', 'mp3', '#444444', '#999999', 'none'),
]

def cover(path, c1, c2, shape, size=360):
    a, b = Image.new('RGB', (size, size), c1), Image.new('RGB', (size, size), c2)
    mask = Image.linear_gradient('L').rotate(-45, expand=False).resize((size, size))
    img = Image.composite(b, a, mask)
    d = ImageDraw.Draw(img, 'RGBA')
    w = size
    if shape == 'moon':
        d.ellipse((w * .52, w * .14, w * .86, w * .48), fill=(255, 255, 255, 200)); d.ellipse((w * .6, w * .1, w * .94, w * .44), fill=img.getpixel((int(w * .9), int(w * .2))) + (255,))
    elif shape == 'circle':
        d.ellipse((w * .2, w * .2, w * .8, w * .8), outline=(255, 255, 255, 170), width=int(w * .05))
    elif shape == 'bars':
        for i in range(9): h = (math.sin(i * 1.3) * .5 + .5) * w * .6 + w * .1; d.rectangle((w * (.08 + i * .1), w * .9 - h, w * (.14 + i * .1), w * .9), fill=(255, 255, 255, 150))
    elif shape == 'star':
        cx = cy = w / 2; pts = [(cx + math.cos(math.pi / 2 + k * math.pi / 5) * (w * .32 if k % 2 == 0 else w * .13), cy - math.sin(math.pi / 2 + k * math.pi / 5) * (w * .32 if k % 2 == 0 else w * .13)) for k in range(10)]
        d.polygon(pts, fill=(255, 255, 255, 190))
    elif shape == 'grid':
        for i in range(1, 6): d.line((w * i / 6, 0, w * i / 6, w), fill=(255, 255, 255, 60), width=2); d.line((0, w * i / 6, w, w * i / 6), fill=(255, 255, 255, 60), width=2)
        d.rectangle((w * .34, w * .34, w * .66, w * .66), fill=(255, 255, 255, 160))
    elif shape == 'wave':
        for k in range(4):
            y0 = w * (.35 + k * .12); d.line([(x, y0 + math.sin(x / w * 6.28 * 2 + k) * w * .05) for x in range(0, w, 6)], fill=(255, 255, 255, 170), width=int(w * .025))
    elif shape == 'bolt':
        d.polygon([(w * .55, w * .12), (w * .3, w * .55), (w * .48, w * .55), (w * .4, w * .88), (w * .72, w * .42), (w * .53, w * .42)], fill=(255, 255, 255, 200))
    img.save(path)

meta = []
for i, (title, artist, album, genre, fmt, c1, c2, shape) in enumerate(SONGS):
    name = f'{i + 1:02d} {artist or "unknown"} - {title}.{fmt}'
    out = os.path.join(OUT, name)
    meta.append({'file': out, 'title': title, 'artist': artist, 'album': album, 'genre': genre})
    if os.path.exists(out):
        continue
    png = os.path.join(OUT, f'.cover{i}.png')
    if shape != 'none':
        cover(png, c1, c2, shape)
    freq = 330 + i * 37
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={freq}:duration={6 + i % 5}']
    has_pic = shape != 'none' and fmt in ('mp3', 'm4a', 'flac')
    if has_pic:
        cmd += ['-i', png]
    cmd += ['-map', '0:a']
    if has_pic:
        cmd += ['-map', '1:v', '-disposition:v', 'attached_pic']
        cmd += ['-c:v', 'mjpeg' if fmt in ('mp3', 'm4a') else 'png']
    cmd += ['-ac', '1', '-ar', '24000' if fmt == 'opus' else '22050']
    if fmt == 'mp3':
        cmd += ['-c:a', 'libmp3lame', '-b:a', '48k', '-id3v2_version', '3']
    elif fmt == 'm4a':
        cmd += ['-c:a', 'aac', '-b:a', '48k']
    elif fmt == 'flac':
        cmd += ['-c:a', 'flac']
    elif fmt == 'opus':
        cmd += ['-c:a', 'libopus', '-b:a', '24k']
    for k, v in (('title', title), ('artist', artist), ('album', album), ('genre', genre)):
        if v:
            cmd += ['-metadata', f'{k}={v}']
    cmd.append(out)
    subprocess.run(cmd, check=True)
    if os.path.exists(png):
        os.remove(png)

json.dump(meta, open(os.path.join(OUT, 'library.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'{len(meta)} songs in {OUT}')
