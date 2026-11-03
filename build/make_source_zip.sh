#!/usr/bin/env bash
# 소스 묶음 (빌드 결과 · 내려받은 도구 · 테스트 음원 제외)
set -euo pipefail
cd /home/claude
OUT=/home/claude/ullim/dist/Ullim-1.0.2-source.zip
rm -f "$OUT"
zip -q -r -X "$OUT" \
  ullim/README.md ullim/web ullim/desktop ullim/android ullim/assets \
  ullim/build/stage_desktop.sh ullim/build/pe_patch.py ullim/build/build_android.sh ullim/build/make_source_zip.sh \
  ullim/test/server.py ullim/test/run_dsp.py ullim/test/dsp-test.html ullim/test/tags-test.html \
  ullim/test/ui_func.py ullim/test/ui_shots.py ullim/test/android_bridge.py ullim/test/electron_test.js \
  -x '*/__pycache__/*'
ls -la "$OUT"
