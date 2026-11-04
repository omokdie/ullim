#!/usr/bin/env bash
# 윈도우 설치 파일(Setup.exe) 만들기 — build/win/Ullim 폴더를 NSIS 로 묶음
set -euo pipefail
ROOT=/home/claude/ullim
NSIS=${NSIS:-/home/claude/dl/x/nsis}
PLUG=${PLUG:-/home/claude/dl/x/nsisres/plugins/x86-unicode}
cd "$ROOT/build/installer"
NSISDIR="$NSIS" "$NSIS/linux/makensis" -V2 -INPUTCHARSET UTF8 \
  -DPLUGINS="$PLUG" -DICON="$ROOT/assets/ullim.ico" -DSRC="$ROOT/build/win/Ullim" \
  -DOUTFILE="$ROOT/dist/Ullim-Setup-1.2.1.exe" ullim.nsi
ls -la "$ROOT/dist/Ullim-Setup-1.2.1.exe"
