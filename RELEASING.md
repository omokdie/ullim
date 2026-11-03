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
bash build/build_windows.sh      # build/win/Ullim  (Electron win32-x64 + 앱, Ullim.exe 아이콘·버전 정보)
bash build/build_installer.sh    # dist/Ullim-Setup-<버전>.exe  (NSIS, 약 5분)
bash build/build_android.sh      # dist/Ullim-<버전>.apk        (aapt2 · javac · d8 · zipalign · apksigner)
rm -f dist/*.idsig
```

필요한 도구 (작업 환경의 `/home/claude/dl/` 아래, 경로는 각 스크립트 맨 위에서 바꿀 수 있음)
- Electron 45.2.1 `electron-v45.2.1-win32-x64.zip`
- NSIS 3 (리눅스용 makensis) + WinShell · nsProcess 플러그인
- Android SDK `platforms/android-33/android.jar`, build-tools 34 (`aapt2`, `d8.jar`, `zipalign`, `apksigner.jar`), JDK 17+

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
python3 .github/scripts/lyrics_feedback.py selftest
python3 test/lyrics_bot_test.py                # 가사 봇 전체 흐름 (가짜 GitHub · LRCLIB · ntfy)
python3 test/android_bridge.py                 # 안드로이드 연결층 흉내
xvfb-run -a node test/electron_test.js <electron> build/desktop-app       # 실제 Electron (리눅스 빌드)
xvfb-run -a node test/electron_ipc_test.js <electron> build/desktop-app   # 가사 의견 · 공용 목록 IPC
```

## 릴리스

1. 위 순서로 빌드하고 시험.
2. main 에 커밋 · 푸시.
3. GitHub **Releases → Draft a new release** → 태그 `v<버전>` (대상 main) → `Ullim-Setup-<버전>.exe`, `Ullim-<버전>.apk` 첨부 → 게시.
   README 의 "최신 릴리스" 링크가 자동으로 새 버전을 가리킵니다.
