#!/usr/bin/env bash
# 윈도우 설치 프로그램을 wine 으로 시험: 이전 버전 설치 → 새 버전 덮어 설치(자동 업데이트와 같은 /S)
#  → 빼낸 부품 · 언어 파일 · 앱 파일 · '설정 > 앱' 크기 기록 확인 → 제거
#   bash test/wine_installer_test.sh dist/Ullim-Setup-1.2.2.exe dist/Ullim-Setup-1.2.3.exe
# wine 에는 compact.exe(파일 압축)가 없어 그 단계는 실패하고 그냥 넘어가야 정상 (크기 기록 = 압축 안 된 크기)
set -u
OLD=$(readlink -f "$1"); NEW=$(readlink -f "$2")
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=${WINE:-/home/claude/dl/x/wine/wine-11.0-amd64-wow64/bin/wine}
WS="${W%/wine}/wineserver"
[ -n "${DISPLAY:-}" ] || { Xvfb :77 -screen 0 1024x768x24 >/dev/null 2>&1 & sleep 2; export DISPLAY=:77; }
# Mono · Gecko 설치 창이 뜨면 멈추므로 끔. 새 접두사는 처음 한 번 1~2분
export WINEPREFIX=${WINEPREFIX:-/tmp/wpfx2} WINEDEBUG=-all WINEDLLOVERRIDES="mscoree=;mshtml=;winemenubuilder.exe="
[ -d "$WINEPREFIX/drive_c/windows/syswow64" ] || { "$W" wineboot -i >/dev/null 2>&1; "$WS" -w; }
U=$(ls -d "$WINEPREFIX"/drive_c/users/*/AppData/Local | head -1)
D="$U/Programs/Ullim"
fail=0; bad() { echo "FAIL: $*"; fail=1; }
reg() { grep -a -A16 'Uninstall\\\\Ullim\]' "$WINEPREFIX/user.reg" | grep -E "\"$1\"" | head -1; }

"$W" "$OLD" /S >/dev/null 2>&1; "$WS" -w
[ -f "$D/Ullim.exe" ] || bad "old install"
echo "old: $(reg DisplayVersion) $(reg EstimatedSize)"

"$W" "$NEW" /S >/dev/null 2>&1; "$WS" -w
echo "new: $(reg DisplayVersion) $(reg EstimatedSize)"
for f in dxcompiler.dll dxil.dll vk_swiftshader.dll vk_swiftshader_icd.json vulkan-1.dll; do [ -e "$D/$f" ] && bad "left $f"; done
[ "$(ls "$D/locales" | tr '\n' ' ')" = "en-US.pak ko.pak " ] || bad "locales: $(ls "$D/locales")"
cmp -s "$D/Ullim.exe" "$ROOT/build/win/Ullim/Ullim.exe" || bad "Ullim.exe differs from build/win"
diff -rq "$D/resources/app" "$ROOT/build/win/Ullim/resources/app" >/dev/null || bad "resources/app differs"
for f in $(cd "$ROOT/build/win/Ullim" && ls | grep -v README.txt); do [ -e "$D/$f" ] || bad "missing $f"; done
du_kb=$(du -sk "$D" | cut -f1)
est=$(reg EstimatedSize | sed 's/.*dword://'); est_kb=$((16#${est:-0}))
echo "folder ${du_kb}KB, EstimatedSize ${est_kb}KB"
[ $((est_kb - du_kb)) -lt 512 ] && [ $((du_kb - est_kb)) -lt 512 ] || bad "EstimatedSize ${est_kb} vs du ${du_kb}"

"$W" "$D/Uninstall.exe" /S >/dev/null 2>&1; "$WS" -w; sleep 2
[ -e "$D" ] && bad "folder left after uninstall: $(ls "$D")"
[ -n "$(reg DisplayName)" ] && bad "uninstall key left"
[ $fail = 0 ] && echo "installer ok"
exit $fail
