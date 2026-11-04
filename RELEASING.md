# 빌드 · 새 버전 내보내기

울림은 Gradle · npm 없이 SDK 도구로 직접 빌드합니다. 빌드는 이 저장소를 받은 리눅스 작업 환경에서 하고,
결과물(설치 파일 · APK)은 GitHub **Releases** 에 올립니다.

## 버전 올리기 (모두 같은 번호로)

| 파일 | 고칠 곳 |
|---|---|
| `desktop/package.json` | `"version"` — Windows 앱 폴더 · README.txt 가 여기서 읽어 감 |
| `web/js/app.js` | `const VERSION` — 설정 화면 표시, 가사 의견의 앱 버전 |
| `build/pe_patch.py` | `FileVersion` · `ProductVersion` · `numeric=(주, 부, 수, 0)` |
| `build/installer/ullim.nsi` | `!define VERSION`, `VIProductVersion` |
| `build/build_installer.sh` | 결과 파일 이름 `Ullim-Setup-<버전>.exe` |
| `build/build_android.sh` | `VER=`, `--version-code` (**매번 1씩 올림** — 안 올리면 업데이트 설치가 안 됨) |

## 빌드

```bash
python3 build/make_icons.py      # (로고를 바꿀 때만) 모든 아이콘 다시 그리기 — --preview 로 미리 보기
bash build/build_windows.sh      # build/win/Ullim  (Electron win32-x64 + 앱, Ullim.exe 아이콘·버전 정보)
bash build/build_installer.sh    # dist/Ullim-Setup-<버전>.exe  (NSIS, 약 5분)
#   (1.2.3 부터 dxcompiler · SwiftShader · vulkan-1 은 빼고, 설치할 때 compact /EXE 로 압축 — HANDOFF '용량')
bash build/build_android.sh      # dist/Ullim-<버전>.apk        (aapt2 · javac · d8 · zipalign · apksigner)
rm -f dist/*.idsig
```

필요한 도구 (작업 환경의 `/home/claude/dl/` 아래, 경로는 각 스크립트 맨 위에서 바꿀 수 있음)
- Electron 45.2.1 `electron-v45.2.1-win32-x64.zip`
- NSIS 3 (리눅스용 makensis) + WinShell · nsProcess 플러그인
- Android SDK `platforms/android-33/android.jar`, build-tools 34 (`aapt2`, `d8.jar`, `zipalign`, `apksigner.jar`), JDK 17+
- (설치 프로그램 시험) wine 11 wow64 `/home/claude/dl/x/wine/wine-11.0-amd64-wow64` — 32비트 i386 라이브러리 없이 32비트 NSIS 를 돌림

### APK 서명 키

`android/keystore/ullim-release.jks` + `keystore.properties` (저장소에 **올리지 않음**, `.gitignore`).
처음 1.0.0 부터 같은 키로 서명했습니다. 키가 바뀌면 사용자가 앱을 지우고 다시 설치해야 하므로 키 파일과 비밀번호를 따로 안전하게 보관하세요.
서명 인증서 SHA-256: `51:c4:77:b3:20:d1:10:c7:a1:ca:4d:a1:6a:14:19:60:0b:df:43:4a:0f:18:c9:a1:d4:45:58:09:9e:05:d6:82`

## 시험

```bash
python3 test/server.py &                       # http://127.0.0.1:8766
python3 test/run_dsp.py                        # 음장 효과 측정
python3 test/ui_func.py                        # 화면 동작
python3 test/lyrics_test.py                    # 가사 찾기 (LRCLIB 가짜 응답)
python3 test/lyrics_share_test.py              # 공용 가사 목록 · 자동 의견 보내기 (가짜 응답)
python3 test/lyrics_retry_test.py              # 가사 서버가 붐빌 때(503/429) 다시 묻기 · 괄호 이름 · 가수 별칭 · 받아들일지 규칙
python3 test/lyrics_korean_test.py             # 한국 노래: 영어 번역/소리 제목 · 피처링 가수 · 흔한 낱말만 겹치면 안 고름 · 파일 이름
node test/autosync_test.mjs                    # 자동 싱크 (글자 수 · 머리말 · 맞춘 줄 · 합성 신호 정렬 · 속도)
node test/autosync_bench.mjs                   # (선택) 자동 싱크 정확도 — JamendoLyrics 79곡이 /home/claude/f90/jamendolyrics 에 있을 때
python3 test/playlists_test.py                 # 플레이리스트 여러 개 (가짜 안드로이드 연결층 · 저장 · 파일 권한)
python3 test/play_glyph_test.py                # 재생 버튼 (울림 표시 ↔ 세모 · 물결 움직임 · 절약 모드) · 밝은/어두운 화면 로고
python3 test/lyrics_data_test.py               # 가사: 모바일 데이터 · 와이파이 전환 · 설정 · 백그라운드 미루기 + 알림 무작위/반복 (가짜 안드로이드)
python3 test/thumbs_dedupe_test.py             # 앨범아트: 같은 그림은 한 번만 저장 · 예전 곡별 기록 합치기 (/tmp/ullim-lib — test/make_library.py)
python3 .github/scripts/lyrics_feedback.py selftest
python3 test/lyrics_bot_test.py                # 가사 봇 전체 흐름 (가짜 GitHub · LRCLIB · ntfy)
python3 test/android_bridge.py                 # 안드로이드 연결층 흉내
python3 test/android_update_test.py            # 안드로이드 자동 업데이트 (JS 쪽: 받기 · [설치] · '이 출처 허용' · 결과 · 끄기)
xvfb-run -a node test/electron_test.js <electron> build/desktop-app       # 실제 Electron (리눅스 빌드)
xvfb-run -a node test/electron_ipc_test.js <electron> build/desktop-app   # 가사 의견 · 공용 목록 IPC
xvfb-run -a node test/electron_playlist_test.js <electron> build/desktop-app /tmp/pltest   # M3U 내보내기 · 가져오기
xvfb-run -a node test/electron_update_test.js <electron> build/desktop-app     # 자동 업데이트 (가짜 GitHub · 받기 · 거절 · 닫을 때 /S · 다시 시작 /RELAUNCH)
xvfb-run -a node test/electron_theme_test.js <electron> build/desktop-app      # 테마에 맞춰 창 아이콘(흰/검은 바탕) · 창 바탕색
bash test/wine_installer_test.sh dist/Ullim-Setup-<이전>.exe dist/Ullim-Setup-<새>.exe   # 설치 프로그램: 덮어 설치(업데이트) · 빠진 부품 지움 · 크기 기록 · 제거 (wine)
xvfb-run -a <electron> --no-sandbox test/mem_driver.js build/desktop-app /tmp/memlib   # (선택) 장면별 메모리 — 개발자 도구 없이 · --gc · --dump
xvfb-run -a <electron> --no-sandbox test/cpu_probe.js build/desktop-app phone          # (선택) 재생 중 CPU (발열 비교)
```

## 릴리스

1. 위 순서로 빌드하고 시험.
2. main 에 커밋 · 푸시.
3. GitHub 저장소 → **Releases → Draft a new release** → **Choose a tag** 에 `v<버전>` 입력 후 *Create new tag* (대상 main)
   → 제목 · 설명 → `Ullim-Setup-<버전>.exe`, `Ullim-<버전>.apk` 를 끌어다 놓기 → **Publish release**.
   README 의 "최신 릴리스" 링크가 자동으로 새 버전을 가리킵니다.
4. **자동 업데이트 알리기** — 릴리스에 두 파일이 올라간 **뒤에**:
   ```bash
   python3 build/make_update_manifest.py <버전> "바뀐 점 한 줄"   # update/latest.json (크기 · SHA-256 · versionCode)
   git add update/latest.json && git commit -m "업데이트 정보 <버전>" && git push
   ```
   설치된 앱(1.1.0+)이 시작 12초 뒤 · 6시간마다 이 파일을 읽어 새 버전을 받아요. 릴리스 파일 이름은 반드시
   `v<버전>/Ullim-Setup-<버전>.exe`, `v<버전>/Ullim-<버전>.apk` (앱이 이 모양의 주소만 받음). 올린 파일을 바꾸면 이 파일도 다시 만들어야 해요(SHA-256).
   APK 는 `--version-code` 를 올리고 **같은 키**로 서명해야 설치돼요. 안드로이드 앱은 알림만 하고 사용자가 브라우저로 받아 설치해요.
   **안드로이드 권한을 함부로 늘리지 마세요**(1.2.3 에서 일반 권한 `ACCESS_NETWORK_STATE` 하나만 추가 — 와이파이/모바일 데이터 구분) — 특히 `REQUEST_INSTALL_PACKAGES`(앱이 다른 APK 설치)를 넣었던 1.1.0 은 Play 프로텍트가
   '유해한 앱'으로 막았어요. 새 권한이 필요하면 빌드 뒤 `aapt2 dump permissions dist/Ullim-<버전>.apk` 를 이전 버전과 비교해 보세요.

APK 서명 키(`android/keystore/`)는 저장소에 없으니, 새 작업 환경에서 APK 를 빌드할 때는 보관해 둔 키 파일 두 개를 그 폴더에 다시 넣어야 합니다.
(키 없이 빌드하면 새 키가 만들어져, 기존 사용자는 앱을 지우고 다시 설치해야 합니다)
