#!/usr/bin/env python3
"""자동 업데이트 정보 파일(update/latest.json) 만들기 — GitHub 릴리스에 설치 파일을 올린 **뒤에** 실행하고 커밋 · 푸시.

    python3 build/make_update_manifest.py 1.1.0 "플레이리스트 여러 개 · 자동 업데이트"

dist/Ullim-Setup-<버전>.exe 와 dist/Ullim-<버전>.apk 의 크기 · SHA-256 과 APK 의 versionCode 를 적는다.
설치된 앱(1.1.0 이상)은 시작 12초 뒤와 6시간마다 이 파일을 읽어, 더 새 버전이면 릴리스에서 받아 설치한다.
릴리스 파일이 아직 없을 때 이 파일을 먼저 올리면 앱이 받기에 실패할 뿐(다음에 다시 시도) 망가지지는 않는다.
"""
import hashlib, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = 'omokdie/ullim'
AAPT2 = os.environ.get('AAPT2', '/home/claude/dl/x/bt/build-tools/34.0.4/aapt2')


def entry(path, url):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return {'url': url, 'sha256': h.hexdigest(), 'size': os.path.getsize(path)}


def version_code(apk):
    out = subprocess.run([AAPT2, 'dump', 'badging', apk], capture_output=True, text=True).stdout
    m = re.search(r"versionCode='(\d+)'", out)
    if not m:
        sys.exit('APK 의 versionCode 를 읽지 못했어요 (AAPT2 경로 확인)')
    return int(m.group(1))


def main():
    if len(sys.argv) < 2 or not re.fullmatch(r'\d+\.\d+\.\d+', sys.argv[1]):
        sys.exit(__doc__)
    ver, notes = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else '')
    dl = f'https://github.com/{REPO}/releases/download/v{ver}/'
    exe = os.path.join(ROOT, 'dist', f'Ullim-Setup-{ver}.exe')
    apk = os.path.join(ROOT, 'dist', f'Ullim-{ver}.apk')
    for f in (exe, apk):
        if not os.path.isfile(f):
            sys.exit(f'없음: {f}')
    android = entry(apk, dl + f'Ullim-{ver}.apk')
    android['versionCode'] = version_code(apk)
    data = {'version': ver, 'notes': notes, 'windows': entry(exe, dl + f'Ullim-Setup-{ver}.exe'), 'android': android}
    out = os.path.join(ROOT, 'update', 'latest.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
