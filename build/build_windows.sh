#!/usr/bin/env bash
# 윈도우 앱 폴더(build/win/Ullim) 만들기: Electron(win32-x64) → Ullim.exe 이름·아이콘·버전 바꾸기 → 앱 넣기
# 다음 단계: build/build_installer.sh (설치 파일)
set -euo pipefail
ROOT=/home/claude/ullim
VER=$(python3 -c "import json;print(json.load(open('$ROOT/desktop/package.json'))['version'])")
EZIP=${EZIP:-/home/claude/dl/electron/electron-v45.2.1-win32-x64.zip}
OUT="$ROOT/build/win/Ullim"
rm -rf "$OUT"; mkdir -p "$OUT"
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$EZIP" "$OUT"
mv "$OUT/electron.exe" "$OUT/Ullim.exe"
rm -f "$OUT/resources/default_app.asar"
bash "$ROOT/build/stage_desktop.sh" "$OUT/resources/app" >/dev/null
python3 "$ROOT/build/pe_patch.py" "$OUT/Ullim.exe" "$ROOT/assets/exe_256.png"
python3 - "$OUT/README.txt" "$VER" <<'PY'
import sys
path, ver = sys.argv[1], sys.argv[2]
text = f"""울림 (Ullim) {ver} — 윈도우용

■ 설치
  Ullim-Setup-{ver}.exe 를 실행하면 설치되고 시작 메뉴 · 바탕 화면에 바로 가기가 생겨요.
  "Windows의 PC 보호" 파란 창이 뜨면 [추가 정보] → [실행]을 누르세요.
  (서명 인증서가 없는 새 프로그램이라 처음 한 번 뜰 수 있어요.)

■ 쓰는 법
  - [파일 추가] / [폴더 추가] 또는 창에 음악 파일·폴더를 끌어다 놓기
  - [음악 폴더 불러오기]: 윈도우 '음악' 폴더 전체를 한 번에 추가
  - 오른쪽 [음장 효과] 탭: 프리셋을 누르거나 효과를 하나씩 켜고 조절
  - [이퀄라이저] 탭: 10밴드 EQ와 18가지 프리셋
  - [가사] 탭: 곡에 맞는 가사를 인터넷(LRCLIB)에서 찾아 보여 줘요. 싱크 가사는 줄을 누르면 그 부분으로 이동.
    가사가 없거나 틀리면 [직접 검색] 또는 [틀린 가사 제보]로 맞는 가사를 고르세요.
    고른 가사는 자동으로 다른 사용자들과 나눠져, 여러 사람이 고른 가사가 모두의 앱에 나와요.
    (설정 → 가사에서 끌 수 있어요. 곡 제목·가수·길이와 가사 번호만 익명으로 보내요.)
  - 단축키: Space 재생/일시정지, ←/→ 5초 이동, Ctrl+←/→ 이전/다음 곡,
            ↑/↓ 볼륨, M 음소거, Ctrl+O 파일 열기, Ctrl+F 검색
  - 작업 표시줄 미리보기 창과 키보드의 미디어 키로도 조작할 수 있어요.

■ 지원 형식
  MP3, M4A(AAC/ALAC), FLAC, OGG, OPUS, WAV, WEBM

■ 요구 사항
  Windows 10 / 11 (64비트)

■ 소스 · 새 버전
  https://github.com/omokdie/ullim

■ 라이선스
  울림은 Electron(MIT) 위에서 동작합니다. 함께 들어 있는 LICENSE,
  LICENSES.chromium.html 파일에 사용된 오픈소스의 라이선스가 있어요.
"""
open(path, 'w', encoding='utf-8-sig', newline='\r\n').write(text)
PY
echo "windows app -> $OUT ($VER)"
