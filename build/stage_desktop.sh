#!/usr/bin/env bash
# 데스크톱 앱 폴더(resources/app) 구성
set -euo pipefail
ROOT=/home/claude/ullim
OUT=${1:-$ROOT/build/desktop-app}
rm -rf "$OUT"; mkdir -p "$OUT/assets"
cp "$ROOT/desktop/main.js" "$ROOT/desktop/preload.js" "$ROOT/desktop/package.json" "$OUT/"
cp -r "$ROOT/web" "$OUT/web"
cp "$ROOT/assets/ullim.ico" "$ROOT/assets/ullim-dark.ico" "$ROOT/assets/tb_play.png" "$ROOT/assets/tb_pause.png" "$ROOT/assets/tb_prev.png" "$ROOT/assets/tb_next.png" "$OUT/assets/"
# 리눅스 창 아이콘은 web/img 의 것을 그대로 씀 (같은 그림을 두 번 넣지 않음)
echo "staged -> $OUT"
