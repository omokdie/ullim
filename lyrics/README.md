# 공용 가사 목록 (`overrides.json`)

앱이 2시간마다 `https://raw.githubusercontent.com/omokdie/ullim/main/lyrics/overrides.json` 을 받아,
곡마다 다른 사용자들이 고른 가사를 씁니다. 이 파일은 **봇이 자동으로 고칩니다** (`.github/workflows/lyrics-feedback.yml`, 30분마다 + 이슈가 열릴 때).

## 모양

```jsonc
{
 "version": 1,
 "updated": "2026-11-04T01:00:00Z",
 "songs": {
  "아이유|밤편지": {                 // norm(가수) + "|" + norm(제목) — web/js/lyrics.js 의 songKey()
   "title": "밤편지", "artist": "아이유",
   "pick": 12345,                     // 쓸 LRCLIB 가사 번호. 0 = 가사 없는 곡. 없으면 자동 검색
   "avoid": [999],                    // 자동 검색에서 뺄 번호 ('틀리다'가 '맞다'보다 많은 번호)
   "votes": { "12345": ["a:3ba3f5f43b926026", "gh:someone"] },   // 후보별 '맞다' 표 (a: 앱 사용자 해시, gh: GitHub 아이디)
   "wrong": { "999": ["a:3ba3f5f43b926026"] },                    // 후보별 '틀리다' 표
   "issues": [12],                    // 관련 GitHub 이슈
   "updated": "2026-11-04",
   "locked": true                     // (선택) 관리자가 고정 — 봇이 더 이상 바꾸지 않음
  }
 },
 "approved": ["아이콘|사랑을했다|4321"],   // 관리자가 승인한 (곡, 가사) 짝 — 다음 의견부터 바로 반영
 "reviews": { "누군가|어떤노래|31": "2026-11-04" },  // 확인용 이슈를 이미 만든 짝
 "meta": { "ntfy": { "time": 1762200000, "ids": ["..."] } }  // 앱 의견을 어디까지 읽었는지
}
```

## 관리자가 할 일

- **확인 요청 이슈** (`needs-review` 라벨): 고른 가사의 제목 · 가수가 곡과 많이 다를 때 봇이 엽니다. 이슈의 "가사 보기" 링크로 확인하고
  - 맞으면 → **`lyrics-approved` 라벨**을 붙이면 몇 분 안에 반영되고 이슈가 닫힙니다. 같은 짝의 다른 의견도 이후 바로 반영돼요.
  - 틀리면 → 그냥 닫기.
- **장난 · 다툼이 있는 곡**: 이 파일을 GitHub 웹에서 직접 고쳐 `"pick"` 을 정하고 `"locked": true` 를 넣으면 고정됩니다.
- **잘못 반영된 곡 되돌리기**: 그 곡 항목을 통째로 지우면 다시 자동 검색으로 돌아갑니다.
- 봇 실행 기록: 저장소 **Actions → 가사 의견 반영**. 직접 돌리려면 **Run workflow**.
