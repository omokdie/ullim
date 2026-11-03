# 울림 — 작업 인계 문서 (Handoff)

> 갱신: 2026-11-04 KST. 다음 세션은 이 문서 → `README.md` → `RELEASING.md` → `lyrics/README.md` 순서로 읽으면 됩니다.
> 소스: **GitHub `omokdie/ullim` (공개, main)**. 클라우드 세션 작업 폴더 `/home/claude/ullim` (origin = 위 저장소).

## 1. 사용자 요구사항 (반영 상태)

| # | 요구 | 상태 |
|---|---|---|
| 1 | 인터넷의 무료 음장 효과를 모두 써서 Windows 프로그램 + Android 앱, 최대한 심플한 디자인 | ✅ 효과 40종 + 10밴드 EQ, 한 화면 구성 (1.0.0) |
| 2 | 제트오디오와 똑같은 인터페이스 | ❌ 상용 프로그램 디자인 복제는 하지 않기로 함 → 독자 디자인, 효과 · EQ · 재생목록을 한 화면에 |
| 3 | Windows 는 zip 이 아니라 설치형 | ✅ NSIS `Ullim-Setup-<버전>.exe` (시작 메뉴 · 바탕 화면 · 제거, 실행 중이면 닫고 설치) |
| 4 | 1.0.1: 노래 제목에 맞는 가사를 인터넷에서 찾아 띄우기 | ✅ LRCLIB 자동 검색 · 싱크 가사 · 파일 속 가사 · `.lrc` · 직접 검색 |
| 5 | JSE 처럼 GitHub 에 올리고, 곡마다 지정되는 가사를 사용자 피드백으로 | ✅ `lyrics/overrides.json` 공용 목록 + 투표 봇 |
| 6 | 가사가 없는 곡은 사용자가 찾아 고르면 자동 지정 + 피드백 자동 전달, 다른 사람에게도 표시 | ✅ 앱 → ntfy.sh(익명) → Actions(30분) → 공용 목록 → 모든 앱(2시간) |

## 2. 구조 요약

- `web/` 두 플랫폼 공통 화면 + 음장 엔진 (빌드 불필요한 ES 모듈). 진입 `js/app.js`, 엔진 `js/engine.js` · `effects.js` · `fx-worklet.js`.
- 가사 `web/js/lyrics.js`: `guessQuery`(태그/파일 이름 → 제목 · 가수), `findOnline`(LRCLIB `/get` → `/search` 점수), `norm`/`songKey`(**봇의 `norm()` 과 반드시 같아야 함** — 33개 까다로운 문자열로 교차 확인함), `loadOverrides`/`communityFor`(공용 목록), `sendFeedback`/`flushFeedback`(의견 보내기 · 오프라인 보관함).
- 찾는 순서(`app.js loadLyrics`): 내가 고른 가사 → 파일 속 가사/.lrc → (자동 찾기 켜짐일 때) 공용 목록의 pick → 이전 자동 결과(avoid 에 든 번호면 버림) → 자동 검색(avoid 제외).
- Windows 셸 `desktop/main.js`: `app://ullim/` 프로토콜(Range 지원)로 음악 파일 제공, IPC `http-get`(LRCLIB · 공용 목록 주소만), `http-post`(의견 메시지함 주소만, 4000바이트 이하), `open-external`(github.com · lrclib.net 만).
- Android 셸 `android/src/kr/ullim/player/MainActivity.java`: `https://appassets.androidplatform.net/` 로 웹 제공, 브리지 `httpGet` · `httpPost` · `openUrl` 같은 허용 목록. **d8 이 오래돼 내부/익명 클래스 대신 static 중첩 클래스 + 람다만** 사용.
- 가사 봇 `.github/scripts/lyrics_feedback.py` + `.github/workflows/lyrics-feedback.yml` — 규칙은 `README.md` "가사" 절과 `lyrics/README.md`.

### 왜 ntfy.sh 인가
앱에 GitHub 토큰을 넣으면 공개 저장소/앱에서 바로 빠져나가 악용되거나 GitHub 가 자동 폐기함. 서버를 따로 운영하지 않고
계정 없이 익명으로 쓸 수 있는 공개 메시지함(ntfy.sh, 12시간 보관)을 대기열로 쓰고, 확인 · 투표 · 기록은 GitHub Actions 가 함.
대신 메시지함 이름(`ullim-lyrics-259gyx3gfnw7`)은 공개라 누구나 의견을 넣을 수 있음 → 봇의 확인(LRCLIB 실재 · 제목/가수/길이 비교),
1인 1표, 한 번에 1인 30건 상한, `needs-review` 승인, `locked` 고정으로 막음. 더 막아야 하면 Cloudflare Worker 같은 중계(IP 제한)로 바꾸는 것이 다음 단계.

## 3. 시험 · 확인 방법
`RELEASING.md` "시험" 절. 이번에 통과한 것: 봇 자체 시험 · 전체 흐름(가짜 GitHub/LRCLIB/ntfy, 두 번 돌려도 같은 결과),
앱 가사 9가지 상황(공용 pick · 가사 없음 · avoid · 직접 골라 자동 전송 · 틀린 가사 제보 · 가사 없는 곡 · 틀렸다고만 · 오프라인 보관 후 재전송 · 설정 끔),
Electron IPC(허용/거부 주소 · 크기 제한), 기존 가사 · 안드로이드 브리지 시험, APK 서명 키가 1.0.0 과 같음.

### 릴리스
이 클라우드 세션은 GitHub **릴리스 만들기 · 브랜치/태그 삭제가 막혀 있음**(API 403). 코드 push · 이슈 · 라벨 · 워크플로 실행은 됨.
v1.0.1 은 사용자 허락을 받아 **사용자 PC 의 Claude 앱 브라우저**(사용자가 GitHub 로그인)로 만들었음:
1. 파일을 임시 브랜치에 27MB 조각으로 push (설치 파일 104MB 는 한 파일로 못 올림: GitHub 100MB 제한, 장치 전송 30MB 제한)
2. 릴리스 작성 페이지에서 JS 로 `raw.githubusercontent.com/<커밋>/…` 조각을 받아 합치고 SHA-256 확인 → `file-attachment.attach(DataTransfer)` 로 첨부
3. 태그 `v1.0.1`(main) · 제목 · 설명 입력 → Publish. 공개 다운로드 APK 해시가 빌드와 같음을 확인.
임시 브랜치 `release-upload-tmp` 는 이 세션에서 지울 수 없어 남아 있음(사용자 확인 후 웹에서 삭제).
APK 서명 키는 세션 컨테이너에만 있으므로 사용자에게 보관용으로 전달함 — 다음 버전 APK 빌드 때 `android/keystore/` 에 다시 넣어야 함.

## 4. 남은 일 · 아이디어
1. 같은 곡이 태그 표기만 다른 경우(아이유 / IU) 공용 목록 열쇠가 달라 따로 집계됨 → 별칭 표 또는 LRCLIB 번호 기준 묶기.
2. 공용 목록이 커지면(수만 곡) 첫 글자별로 나눠 받기.
3. Windows 코드 서명 인증서(없으면 SmartScreen 경고), 자동 업데이트(electron-updater / APK 새 버전 안내).
4. GitHub Actions 로 exe · apk 자동 빌드(지금은 작업 환경에서 빌드 후 릴리스에 첨부).
