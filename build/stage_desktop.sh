#!/usr/bin/env bash
# 데스크톱 앱 폴더(resources/app) 구성
set -euo pipefail
ROOT=/home/claude/ullim
OUT=${1:-$ROOT/build/desktop-app}
rm -rf "$OUT"; mkdir -p "$OUT/assets"
cp "$ROOT/desktop/main.js" "$ROOT/desktop/preload.js" "$ROOT/desktop/package.json" "$OUT/"
cp -r "$ROOT/web" "$OUT/web"
cp "$ROOT/assets/ullim.ico" "$ROOT/assets/ullim-dark.ico" "$ROOT/assets/tb_play.png" "$ROOT/assets/tb_pause.png" "$ROOT/assets/tb_prev.png" "$ROOT/assets/tb_next.png" "$OUT/assets/"
cp "$ROOT/web/img/icon.png" "$OUT/assets/icon.png"
cp "$ROOT/web/img/icon-dark.png" "$OUT/assets/icon-dark.png"
echo "staged -> $OUT"
