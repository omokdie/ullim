# 울림 — 작업 인계 문서 (Handoff)

> 갱신: 2026-11-04 KST (1.2.0 준비). 다음 세션은 이 문서 → `README.md` → `RELEASING.md` → `lyrics/README.md` 순서로 읽으면 됩니다.
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
| 7 | 1.0.2: 있는 노래인데 가사 못 찾음 · 인터넷 되는데 연결 안 됨 | ✅ LRCLIB 503 다시 묻기 · 이름 맞추기 (아래 1.0.2 절) |
| 8 | 1.1.0: 플레이리스트를 만들고 관리 | ✅ 여러 플레이리스트 · 편집(여러 곡 · 끌어서 순서) · 관리 창 · PC M3U |
| 9 | 1.1.0: 이미 받은 사람들(PC · 안드로이드)도 자동 업데이트 | ✅ PC 는 자동 설치. 안드로이드는 1.1.1 부터 알림 + [받기](브라우저) — 아래 1.1.1 절 |
| 10 | 1.1.1: 안드로이드에서 '유해한 앱'이라 설치가 안 됨 | ✅ 1.1.0 의 앱 내 APK 설치 기능(REQUEST_INSTALL_PACKAGES 등) 제거 → 권한이 1.0.2 와 같아짐 |
| 11 | 1.2.0: 유튜브 뮤직처럼 홈에 플레이리스트 타일 2×6(옆으로 밀기) · 최근에 들은 곡 6개(더보기) · 장르별 곡, 기존 기능 유지 | ✅ 아래 1.2.0 절 |
| 12 | 1.2.0: 아이폰 같은 리퀴드 글라스(휴대폰은 가벼운 굴절, 배터리 최소) | ✅ `web/js/glass.js` (자동 · 풍부 · 가볍게 · 끄기, 절약 모드에서 끔) |
| 13 | 1.2.0: 한국 노래 가사를 잘 못 찾음 (예: 내가 바보라서 그래 feat KIXO) | ✅ 가수로 찾기 · 영어 번역/소리 제목 · 피처링 가수 · 파일 이름 (아래) |
| 14 | 1.2.0: 싱크 없는 가사(예: 퇴사할게여)도 노래에 맞춰 넘어가게 | ✅ 자동 싱크 `web/js/autosync.js` (아래) |

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
v1.0.2 · v1.1.0 도 같은 방법. 주의할 점 (v1.1.0 때 겪음):
- 첨부는 `document.querySelector('file-attachment.js-upload-release-file').attach(dt)` — 첫 번째 `file-attachment` 는 설명 칸(그림용)이라 거부됨.
  첨부하면 GitHub 가 untagged 초안을 만들어 파일을 올림(`is-uploading` 클래스가 빠지면 끝).
- 태그: Tag 버튼 → **Create new tag** → 대화상자에 `v<버전>` → Create (게시할 때 main 에서 만들어짐).
- 첫 Publish 가 회색으로 멈추고 아무것도 안 되면: **Save draft** → 릴리스 목록의 초안 편집 페이지를 새로 열기 → Publish.
- 확인: `gh api repos/omokdie/ullim/releases/tags/v<버전>` 의 assets[].digest(sha256) 가 빌드와 같은지. 그다음 RELEASING 4단계(update/latest.json).
APK 서명 키는 세션 컨테이너에만 있으므로 사용자에게 보관용으로 전달함 — 다음 버전 APK 빌드 때 `android/keystore/` 에 다시 넣어야 함.

### 1.1.0 — 플레이리스트 여러 개
- `app.js`: `pls`(전체) · `shown`(왼쪽에 보이는 목록) · `playPl`(재생 중인 목록). **`list` 는 항상 `playPl.tracks` 와 같은 배열** — 재생 쪽 코드(playIndex ·
  다음 곡 · 섞기 order · 크로스페이드 · 가사)는 그대로 list/P.index 를 쓴다. 화면 · 편집 함수는 `shown.tracks` 를 쓴다(refreshView · addItems ·
  removeTracks · sortList · moveTrack · clearList). 보이는 목록에서 곡을 누르면 `adoptShown()` 으로 재생 목록이 바뀐다.
- 같은 파일이 여러 목록에 있으면 곡 객체는 목록마다 따로. 안드로이드 파일 권한은 어느 목록에도 안 남은 곡만 돌려줌(`releaseUnused`).
- 저장 `ullim.playlists.v2` = { v:2, play, shown, tracks:[[key,name,title,artist,album,dur,tagged]…], lists:[{id,name,items:[tracks 번호]}] }
  (곡 정보 한 번만 저장). 처음 실행 때 1.0.x 의 `ullim.playlist.v1` 을 '재생목록' 으로 옮기고, v2 저장에 성공하면 v1 은 지움
  (안 지우면 큰 라이브러리가 두 번 저장돼 저장 공간 5MB 를 넘김). 저장 실패 시: 가사 임시 저장 줄이기(`cacheShrink`) → v1 비우고 재시도 →
  그래도 안 되면 v1 되돌리고 안내. 불러오기는 망가진 저장 내용(null · 숫자 · 같은 id)도 견딤.
- 편집 모드(`EDIT`): 곡 고르기(Set of 곡 객체) · ≡ 끌기(`#vlist` 가 포인터를 잡음, 행은 가상 스크롤로 다시 그려져도 됨) · 아래 편집 막대.
- PC M3U: `desktop/main.js` 'save-playlist'(대화상자로 고른 곳에 UTF-8, .m3u 면 BOM) · 'open-playlists'(M3U/M3U8/PLS, 상대 경로 · file:// ·
  CP949 옛 파일, 없는 파일과 인터넷 주소는 건너뜀). 시험용 `ULLIM_PLAYLIST_TEST_DIR`.
- 시험: `test/playlists_test.py`(옮기기 · 만들기 · 넣기 · 편집 · 끌기 · 재생 중 목록 바꾸기 · 권한 · 이름/복사/관리/지우기 · 다시 열기 · 휴대폰 화면),
  `test/electron_playlist_test.js`(M3U 내보내기 · 가져오기).

- 독립 검토(별도 에이전트)에서 나온 9건 모두 고침: 위 저장 공간 문제(높음), 검색 중 끌기 위치(Ctrl+F 는 편집을 끝냄 + 보이는 줄 → 곡 번호),
  크로스페이드 대기 중 목록이 바뀌면 곡으로 다시 찾기, 끌기 취소(Esc · 뒤로 · Delete · 목록 변경), 메뉴가 열려 있으면 단축키 무시,
  창 Esc 는 문서 전체에서 한 번에 맨 위 창만, 아무것도 안 틀었을 때 다음/이전 곡은 보이는 목록에서, M3U 못 찾은 곡 수 · UTF-16BE ·
  못 읽은 파일 안내 · 인터넷 쪽 공유 폴더(\\서버) 경로 건너뛰기(집 · 회사 NAS 는 허용).

### 1.1.0 — 자동 업데이트
- 정보 파일 `update/latest.json` = { version, notes, windows:{url,sha256,size}, android:{url,sha256,size,versionCode} }.
  릴리스에 파일을 올린 **뒤** `build/make_update_manifest.py` 로 만들어 push (RELEASING 4단계). 화면 `web/js/update.js` 가 시작 12초 뒤 · 6시간마다 읽음
  (설정 '자동 업데이트' 끄면 안 읽고, 받아 둔 파일도 지움). 네이티브 쪽은 `v<버전>/Ullim-Setup-<버전>.exe` · `v<버전>/Ullim-<버전>.apk`
  모양의 이 저장소 릴리스 주소만, 지금보다 새 버전만, 크기 · SHA-256 이 맞을 때만 씀.
- Windows `desktop/main.js`: 설치판(실행 파일 옆 Uninstall.exe)일 때만. `%APPDATA%\Ullim\update\` 에 받기 → `quit` 때 `/S` 로 따로 떨어진
  프로세스 실행(윈도우 종료 · 로그오프 중이면 안 함) · '지금 다시 시작' 은 `/S /RELAUNCH`. 설치 프로그램(ullim.nsi)은 조용한 설치일 때 앱이
  스스로 닫힐 때까지 최대 10초 기다린 뒤에만 강제로 닫고(설정 저장 보호), 지운 바탕 화면 바로 가기는 다시 만들지 않고, /RELAUNCH 면 새 버전 실행.
  시작 5초 뒤 지난 버전 설치 파일 · 받다 만 파일 정리. 시험용 `ULLIM_UPDATE_TEST=<주소>/` (받는 곳 바꾸기 + 설치 대신 ran.json 기록).
- (1.1.0 만, 1.1.1 에서 제거) Android `Updater.java`: cacheDir/update 에 받기 → SHA-256 · `getPackageArchiveInfo`(같은 패키지 · 더 큰 versionCode) 확인 →
  [설치] 때 PackageInstaller 세션(`setRequireUserAction(NOT_REQUIRED)`, 권한 `REQUEST_INSTALL_PACKAGES` · `UPDATE_PACKAGES_WITHOUT_USER_ACTION`).
  '이 출처 허용'이 꺼져 있으면 설정 화면 → 돌아오면(onResume) JS `__ullimUpdatePermission` 으로 이어서 설치. 결과는 내부 수신기
  `Updater$StatusReceiver` → JS `__ullimUpdateResult`. 확인 창이 필요하면 화면이 앞에 있을 때만 띄우고 아니면 취소(-1). 새 버전으로 바뀌면
  `Updater$ReplacedReceiver`(MY_PACKAGE_REPLACED)가 '업데이트했어요' 알림(울림이 시작한 업데이트일 때만, filesDir/update-committed 표시).
  재생 중이 아닐 때 뒤로 가기로 나가면 조용히만 설치 시도(12+ · 허용된 경우, 아니면 아무것도 안 함).
- 시험: `test/electron_update_test.js`(실제 Electron + 가짜 GitHub), `test/android_update_test.py`(가짜 브리지로 JS 흐름). 안드로이드 네이티브
  설치 흐름은 실기기가 없어 컴파일 · dex · 매니페스트까지만 확인 → 실제 기기에서 1.1.0 → 다음 버전으로 처음 업데이트할 때 확인 필요.

### 1.1.1 — 안드로이드 '유해한 앱 차단됨' (Play 프로텍트)
- 사용자 확인: 1.0.x 는 설치됐고 **1.1.0 APK 만** 설치가 막힘. 1.1.0 에서 새로 넣은 것 = `REQUEST_INSTALL_PACKAGES` ·
  `UPDATE_PACKAGES_WITHOUT_USER_ACTION` 권한 + 앱이 APK 를 내려받아 PackageInstaller 로 설치하는 코드(Updater.java) → 알려진 악성 앱
  '드로퍼' 모양이라 Play 프로텍트가 PHA(유해) 로 분류한 것으로 판단. 1.1.1 은 이것을 모두 빼서 권한 목록이 1.0.2 와 똑같음.
- 안드로이드 업데이트는 이제 확인 + 알림만: update/latest.json 의 versionCode 가 더 크면 목록 위 알림 [받기] → `openUrl` 로 릴리스의 APK 주소를
  브라우저에서 열기(받은 파일을 사용자가 눌러 설치). [×] 로 그 버전 알림 숨김(`S.updHidden`), '업데이트 확인'을 누르면 다시 보임.
- 그래도 막히면: Play 프로텍트 이의 신청 https://support.google.com/googleplay/android-developer/contact/protectappeals (개발자가 APK 주소 ·
  패키지 kr.ullim.player · 서명 인증서 SHA-256 을 적어 냄). 2026-09 부터 일부 나라, 2027 부터 전 세계로 '개발자 인증'이 단계적으로 필요해지는
  계획이 있음 — 한국 적용 시점이 오면 Android Developer Console 등록이 필요할 수 있음.

### 1.2.0 — 새 화면 (홈 · 플레이리스트 화면 · 재생 화면 · 리퀴드 글라스)
- `index.html` 전면 개편: 왼쪽 메뉴(PC, `#side`) · 위 막대(`#topbar`) · 페이지 스크롤(`#scroller`) 안의 화면들(`#viewHome` · `#viewList` · `#viewFx` ·
  `#viewEq` · `#viewLyr` · `#viewSet`) · 재생 막대(`#pbar`, 휴대폰은 미니 플레이어) · 아래 메뉴(`#bnav`, 휴대폰) · 재생 화면(`#player`).
  휴대폰/PC 배치는 `PHONE_MQ`(899px 이하 = 휴대폰).
- 화면 이동 `go(view)` / `back()` (`NAV`): 홈 · 음장 · EQ · 가사(PC) · 설정은 메뉴 화면, `list`(플레이리스트 화면)는 그 아래로 들어가는 화면.
  안드로이드 뒤로 가기 순서: 대화상자 → 메뉴 → 편집 → 재생 화면 탭 → 재생 화면 → 검색 → 이전 화면 → 홈이면 false(앱이 뒤로).
  옛 시험 호환용으로 `__ullim.setTab()` 남김.
- 홈(`renderHome`): 장르 칩 → 플레이리스트 타일(`.pgrid`, grid-auto-flow column 2줄, 한 화면 6칸/휴대폰 3.3칸) → 최근에 들은 곡(`recent`,
  `ullim.recent.v1`, 5초 넘게 들은 곡) → 장르별(`genreGroups`, 태그 장르를 발라드 · 댄스 등으로 묶음). 내용 서명(`homeSig`)이 같으면 다시 그리지 않음.
  가상 목록(최근 · 장르 · 모든 곡, `virtual: true`)은 진짜 곡 객체를 함께 쓰는 읽기 전용 스냅숏 — 재생은 보통 목록과 같고 저장하지 않음
  (`savePlaylists` 는 가상 목록이면 마지막 진짜 목록 `P.lastReal` 을 기억).
- 장르: `tags.js` 가 TCON/TCO · Vorbis GENRE · MP4 ©gen/gnre · WAV IGNR · ID3v1 을 읽음(`cleanGenre`). 1.1.x 에서 옮겨 온 곡은 장르를 몰라서
  `backfillGenres` 가 화면이 켜져 있고 절약 모드가 아닐 때 쉬는 시간에 한 곡씩 다시 읽음. 저장 행에 8번째 칸(genre) 추가.
- 플레이리스트 화면: 큰 모자이크 그림 · 재생/셔플/추가/⋯ (`#plPlay` `#plShuffle` `#plAdd` `#plMenu`), 목록은 페이지 스크롤 안의 가상 목록
  (`ROW_H` 56, `listTop` 으로 위치 계산), 지금 곡 표시는 파일(key) 기준이라 어느 목록에서든 보임.
- 앨범아트 `thumbs.js`: 160px JPEG + 대표 색을 IndexedDB `ullim-art` 에. 보일 때만(IntersectionObserver) · 한 번에 하나 · 쉬는 시간에.
  지나간 줄은 `forgetPending`. 그림을 만들며 읽은 태그(장르 등)는 `setTagSink` 로 앱에 넘겨 같은 파일을 두 번 읽지 않음. 대표 색은 배경(`--amb`).
- 리퀴드 글라스 `glass.js`: 요소 크기에 맞춘 변위 지도(가장자리일수록 안쪽을 끌어옴)를 SVG feDisplacementMap 으로 `backdrop-filter: url(#lgN)` 에 검.
  크기가 바뀔 때만 지도를 반 해상도로 다시 그림. 모드 `html[data-glass]`: rich(PC) · light(휴대폰: `#pbar` · `#bnav` 만) · off. 자동은
  `navigator.getBattery`(20% 이하 · 충전 아님) + 안드로이드 `UllimAndroid.powerSave()`(PowerManager.isPowerSaveMode, 권한 없음) + '투명도 줄이기'.
  유리 위 진행 막대는 0.5초에 한 번만 바꾸고(`pprog`), 비주얼라이저는 보이는 곳이 있을 때만 30fps.
- 독립 검토(별도 에이전트)에서 나온 15건 고침: PC 재생 화면 메뉴에서 다른 화면으로 가면 재생 화면 닫기, 비주얼라이저가 캔버스가 보이게 될 때
  다시 시작, 다른 목록을 보는 중에는 곡이 바뀌어도 스크롤하지 않기, 목록 줄의 그림 요청만 취소(`thumb(key, {cancelable})`) · 빈 대기열 ·
  같은 그림 두 번 읽기, 장르를 읽는 동안 홈을 자주 다시 그리지 않기(만지는 중 미룸 · 진행 글자만 바꿈), '플레이리스트에 넣기'가 엉뚱한 목록을
  빼던 것, 홈에서 튼 곡의 이어 듣기, 다음 트랙 그림은 보일 때만, 태그를 안 읽은 곡도 장르 채우기, 유리 크기 바뀜 모두 반영,
  PC 재생 막대의 시간 · 진행 막대를 덜 자주 바꾸기(유리 다시 그리기 줄임), 재생 화면이 다 올라온 뒤 뒤 화면 숨기기, 가상 목록이 곡 객체를 함께 씀.
- 재생 화면: 휴대폰은 위로 올라오는 전체 화면(아래로 밀어 닫기), PC 는 재생 막대 위를 덮음. '다음 트랙'(`upcoming`, 무작위 · 반복 반영) ·
  '가사' 탭. 가사 칸(`#paneLyr`)은 하나를 PC 가사 화면 ↔ 재생 화면 사이로 옮겨 씀(`hostLyrics`).

### 1.2.1 — 휴대폰 밀어서 화면 옮기기 · 리퀴드 글라스 로고
- 홈의 '재생 중' 플레이리스트 테두리가 옆으로 밀리는 줄(overflow)에 잘리던 것 → 그림 안쪽 테두리(`.mosaic::after` inset)로.
- 휴대폰: `#main` 에서 좌우로 밀면 `TABS` = 홈 · 음장 · EQ · 설정 순서로 옮김(플레이리스트 화면은 홈 자리: 오른쪽 = 뒤로, 왼쪽 = 음장).
  가로 판정 = 14px 넘게 · 세로의 1.6배 넘게, 옮김 = 화면 폭 22% 넘게 또는 빠르게 40px. 슬라이더 · EQ 막대 · ≡ 손잡이 · 위 막대 위, 화면
  가장자리 20px(안드로이드 뒤로 가기 몸짓)에서는 안 함. 옆으로 밀리는 줄 위에서는 그 줄이 더 밀릴 수 있으면 줄을 밀고 끝에 닿았을 때만 화면을 옮김.
  아래 메뉴를 눌러도 같은 방향으로 미끄러져 들어옴(`slideIn`).
- 로고: `build/make_icons.py` 가 모든 아이콘을 코드로 그림 — 남색 바탕에 파랑 · 보라 · 청록 빛, '울림' 기호(점 + 소리 물결)를 유리 막대로
  (뒤 빛 굴절 · 젖빛 · 왼쪽 위 반짝임 · 그림자 · 색 그림자), 바깥 타일은 유리판 테두리. 만드는 것: `assets/icon-1024 · icon-256 · exe_16/32/48/256 ·
  ullim.ico · ic_launcher_*`, `web/img/icon.png`, 안드로이드 `mipmap-*/ic_launcher.png`(옛 기기) + 적응형 `drawable-*/ic_launcher_bg · _fg · _mono`
  (`mipmap-anydpi-v26/ic_launcher.xml`, 단색은 안드로이드 13 테마 아이콘용). 알림 아이콘(ic_stat) · 작업 표시줄 버튼은 그대로(평면이어야 함).

### 1.2.0 — 한국 노래 가사 · 자동 싱크
- `lyrics.js scanByArtist`: 제목으로 못 찾고 곡 길이를 알 때, 가수(괄호 안 다른 표기 · `aliases.js` · 제목 속 feat 가수)로 검색 →
  길이 2초 안 + (가사 속에 제목의 한글 낱말이 절반 이상 — 흔한 낱말 `COMMON` 제외 — 또는 제목 소리가 같음 `soundAlike`) + 후보 곡이 하나일 때만.
  많은 곡을 낸 가수는 이름 검색 20개 안에 없을 수 있어 제목 낱말을 영어로 바꾼 '가수 + 낱말'(`KO_EN`, 봄 → spring)로도 찾음.
  실제 LRCLIB 로 확인: 벚꽃 엔딩 · 봄이 좋냐?? · 바운스 · 아쿠아맨 · 내가 바보라서 그래 feat KIXO 찾음, 내 사람(SG워너비 · LRCLIB 에 없음)은 엉뚱한 곡 안 고름.
  시험 `test/lyrics_korean_test.py`.
- 파일 이름(`fromFileName`): '가수 - 제목', 띄어쓰지 않은 '아이유-밤편지', [MV] · (Official MV) · [가사 Lyrics] 꼬리, 맥의 풀어 쓴 한글(NFC).
- 자동 싱크 `web/js/autosync.js`: LRCLIB 에 싱크 가사가 없는 한국 노래가 많음(퇴사할게여 · 내가 바보라서 그래 모두 일반 가사뿐) → 가사 화면이
  보일 때만 음악 파일을 한 번 8000Hz 로 풀어(OfflineAudioContext, 60MB · 15분 넘으면 글자 수로만 어림) 가운데 · 목소리 대역 에너지로
  '노래하는 구간' 곡선을 만들고, 줄마다 음절 수 × 빠르기로 길이를 잡아 DP 로 정렬(빠르기 여러 개 시도, 빈 줄 = 쉬는 구간이 길어도 됨).
  결과 · 곡선(Int8, 5분에 약 1.5KB) · 사용자가 맞춘 줄을 IndexedDB `ullim-sync` 에 저장 (곡 키 + 가사 해시 + 길이).
  화면(`app.js runAutoSync` · `anchorLine`): 자동 맞춤 가사는 **줄을 누르면 '지금 이 줄'**(0.3초 앞당김)로 맞추고, 저장해 둔 곡선으로
  나머지를 다시 정렬(`saveAnchors`). 길게 누르기 · 오른쪽 클릭 = 이 줄부터 듣기 · 맞춘 시간 지우기. 확신도 0.6 미만이면 '자동 맞춤(대략)',
  0.25 미만이면 강조를 약하게. 설정 → 가사 → '싱크 없는 가사 자동으로 맞추기'.
  정확도(JamendoLyrics 79곡 · 3,383줄, `test/autosync_bench.mjs`): 음악 분석만으로 줄 시작 1초 안 25.7%(가운데값 오차 4.8초),
  노래하는 시간 중 ±1줄 안 57.8% / 글자 수로만 7.2% / **6줄마다 한 번 눌러 맞추면 1초 안 72%, 가운데값 0.22초**. 확신도 0.6 이상인 곡은 ±1줄 87.5%.
  약한 곳: 가운데에 놓인 악기 솔로 · 전주(목소리로 착각), 긴 '우우 · 라라' 애드리브, 랩 ↔ 느린 후렴처럼 빠르기가 크게 바뀌는 곡.
  분석 시간: 이 VM 에서 곡당 약 0.1초(+ 파일 풀기), 휴대폰은 3~5배.

### 1.0.2 — 가사를 못 찾던 문제 (실제 LRCLIB 로 확인)
- LRCLIB 이 요청의 30~50%를 `503 ServerOverloaded`(Retry-After: 1)로 돌려보냄(2026-11 기준, 더 엄격한 요청 한도 도입). 1.0.1 은 이를
  '인터넷 끊김'으로 보여 주고, 일부 검색만 막혀도 '없음'을 3일 기억했음.
  → `lyrics.js request()`: 429/5xx/시간 초과는 Retry-After(+30% 흔들기) 만큼 기다려 최대 4번. 끝까지 못 물었으면 LookupError('busy'|'offline')
  → '없음'으로 기억하지 않음, 화면에서 '서버 붐빔' / '인터넷 끊김' 구분 + 30초 뒤(또는 연결되면) 자동 재시도. '없음'은 끝까지 찾았을 때만 하루 기억(v:2).
- 이름 맞추기: LRCLIB 은 'IU (아이유)', 'Through the Night (밤편지)' 처럼 괄호 안에 다른 언어 이름을 둠 → `names()` 가 괄호 안 · 밖을 따로 비교,
  여러 가수 나누기, `web/js/aliases.js` 한글 ↔ 영어 가수 이름(아이유 ↔ IU 등)으로 검색 · 비교.
- 받아들이기 규칙(`rate()`): 제목이 같아야 함(일부만 같으면 가수 같고 길이 3초 안). 가수가 다르면 길이 2초 안(한글↔영어 표기면 4초).
  제목 · 가수 같은데 길이가 15초 넘게 다르면 시간 맞춤 없이 가사만. 실제 서버로 13+12곡 시험: 진짜 곡 모두 맞는 싱크 가사, 틀린 짝 0.
- User-Agent 를 LRCLIB 규칙대로 `Ullim v<버전> (https://github.com/omokdie/ullim)`. 더 높은 한도가 필요하면 LRCLIB 개발자 포털에서
  앱 등록(Lrclib-App-Id, 공개 값이라 앱에 넣어도 됨) → 요청 헤더에 추가하면 됨.

## 4. 남은 일 · 아이디어
1. 같은 곡이 태그 표기만 다른 경우(아이유 / IU) 공용 목록 열쇠가 달라 따로 집계됨 → 별칭 표 또는 LRCLIB 번호 기준 묶기.
2. 공용 목록이 커지면(수만 곡) 첫 글자별로 나눠 받기.
3. Windows 코드 서명 인증서(없으면 SmartScreen 경고). 자동 업데이트는 1.1.0 에서 완료(앱이 직접 받은 파일에는 '인터넷에서 받음' 표시가 붙지 않아 보통 경고 없이 설치됨 — 실제 Windows 에서 첫 업데이트 때 확인).
4. GitHub Actions 로 exe · apk 자동 빌드(지금은 작업 환경에서 빌드 후 릴리스에 첨부).
