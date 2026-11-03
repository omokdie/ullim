#!/usr/bin/env python3
"""고른 가사 의견 → lyrics/overrides.json (앱들이 받아 가는 공용 가사 목록)

의견이 들어오는 곳 두 가지:
  1) 앱이 자동으로 보내는 의견 — ntfy.sh 공개 메시지함(NTFY_URL, 12시간 보관)에 익명으로 올라옴
  2) GitHub 이슈 양식(.github/ISSUE_TEMPLATE/lyrics.yml)으로 직접 쓴 제보
곡마다 어떤 LRCLIB 가사를 쓸지 투표로 정한다.

  python3 lyrics_feedback.py apply  [결과파일]   새 의견을 모두 읽어 overrides.json 갱신, 이슈에 할 일을 결과파일(JSON)에 적음
  python3 lyrics_feedback.py report 결과파일      (overrides.json 을 올린 뒤) 이슈에 댓글 · 라벨 · 닫기, 확인용 이슈 만들기
  python3 lyrics_feedback.py selftest             오프라인 자체 시험

환경 변수: GH_TOKEN (GitHub 토큰), REPO (owner/name) · 시험용: GITHUB_API_URL, LRCLIB_API, NTFY_URL, OVERRIDES_PATH

규칙
- 곡 열쇠는 norm(가수) + '|' + norm(제목) — 앱의 web/js/lyrics.js 의 norm()/songKey() 와 똑같아야 한다.
- 한 사람은 한 곡에 한 표: 같은 사람이 다시 제보하면 그 곡에 대한 이전 의견을 지우고 새 의견만 남긴다.
  (앱 사용자 = 'a:' + 앱이 만든 무작위 번호의 해시, GitHub 사용자 = 'gh:' + 아이디)
- 후보 점수 = '맞다' 표 수 - '틀리다' 표 수. 가장 높은 후보(1점 이상)를 pick 으로. 동점이면 지금 pick 유지,
  그것도 아니면 방금 제보된 후보.
- avoid = '틀리다' 표가 '맞다' 표보다 많은 번호 — 앱의 자동 찾기가 이 번호를 건너뛴다.
- pick 0 = 가사가 없는 곡.
- 맞는 가사 번호는 LRCLIB 에 실제로 있어야 하고, 제보한 곡과 같은 곡이어야 한다:
  제목 · 가수가 비슷하거나, 둘 중 하나가 비슷하고 곡 길이가 3초 안으로 같으면 통과.
  아니면 확인용 이슈(needs-review)를 만들거나 붙여 두고 → 관리자가 lyrics-approved 라벨을 붙이면 반영.
- 관리자가 overrides.json 의 곡에 "locked": true 를 적으면 그 곡은 더 이상 바꾸지 않는다.

"""
import datetime
import difflib
import hashlib
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.environ.get('OVERRIDES_PATH') or os.path.join(ROOT, 'lyrics', 'overrides.json')
LRCLIB = os.environ.get('LRCLIB_API') or 'https://lrclib.net/api'
GITHUB_API = os.environ.get('GITHUB_API_URL') or 'https://api.github.com'
NTFY_URL = os.environ.get('NTFY_URL') or 'https://ntfy.sh/ullim-lyrics-259gyx3gfnw7'   # web/js/lyrics.js 의 FEEDBACK_URL
MAX_PER_VOTER = 30          # 한 번 돌 때 한 사람(앱)에게서 받는 의견 수
VOTER_MARK = re.compile(r'<!--\s*ullim-voter:\s*(a:[0-9a-f]{16})\s*-->')
UA = 'UllimLyricsBot/1.0 (+https://github.com/omokdie/ullim)'
TITLE_PREFIX = '[가사]'
LABELS = {
    'lyrics': ('1f8a70', '가사 제보'),
    'needs-review': ('d4a72c', '관리자 확인이 필요한 가사 제보'),
    'lyrics-approved': ('2da44e', '관리자가 확인한 가사 제보 — 반영'),
}
FIELDS = {
    '노래 제목': 'song', '가수': 'artist', '곡 길이(초)': 'duration',
    '틀린 가사 번호': 'wrong_id', '맞는 가사 번호': 'correct_id', '하고 싶은 말': 'note', '앱 버전': 'app_version',
}


# ---------------------------------------------------------------- 곡 열쇠

def norm(s):
    """web/js/lyrics.js 의 norm() 과 똑같이: 소문자 → NFKC → (괄호)[대괄호] 지움 → feat. 이하 지움 → 글자·숫자만"""
    s = unicodedata.normalize('NFKC', (s or '').lower())
    s = re.sub(r'\(.*?\)|\[.*?\]', '', s)
    s = re.sub(r'(^|\s)(feat|ft)\.\s.*$', '', s)
    return ''.join(ch for ch in s if unicodedata.category(ch)[0] in 'LN')


def song_key(artist, title):
    return norm(artist) + '|' + norm(title)


# ---------------------------------------------------------------- 이슈 양식 읽기

def parse_form(body):
    """이슈 양식 본문('### 라벨' 다음 줄들이 값)을 {필드: 값} 으로"""
    out = {}
    parts = re.split(r'^###[ \t]+(.+?)[ \t]*$', (body or '').replace('\r\n', '\n'), flags=re.M)
    for i in range(1, len(parts) - 1, 2):
        key = FIELDS.get(parts[i].strip())
        if not key:
            continue
        val = re.sub(r'<!--.*?-->', '', parts[i + 1], flags=re.S).strip()
        out[key] = '' if val == '_No response_' else val
    return out


def parse_id(s):
    """LRCLIB 번호 칸: '' → None, 'none'/'없음'/0 → 0, 숫자 → int, 그 밖 → 'bad'"""
    s = (s or '').strip().lstrip('#').strip()
    if not s:
        return None
    if s.lower() in ('none', '없음', 'no', 'instrumental'):
        return 0
    if re.fullmatch(r'\d{1,9}', s):
        return int(s)
    return 'bad'


# ---------------------------------------------------------------- 확인 · 투표

def similar(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def check_record(rec, song, artist, dur=0):
    """LRCLIB 기록이 제보한 곡과 같은 곡인가 → (ok, 이유)"""
    t = similar(rec.get('trackName') or rec.get('name') or '', song)
    ar = similar(rec.get('artistName') or '', artist) if artist else None
    try:
        close = bool(dur) and bool(rec.get('duration')) and abs(float(rec['duration']) - float(dur)) <= 3
    except (TypeError, ValueError):
        close = False
    if t >= 0.6 and (ar is None or ar >= 0.5):
        return True, ''
    if t >= 0.6 and close:                       # 가수 표기만 다름 (아이유 / IU)
        return True, ''
    if ar is not None and ar >= 0.7 and close:   # 제목 표기만 다름 (한글 / 영어 제목)
        return True, ''
    if t < 0.6:
        return False, f"제목이 많이 달라요 (LRCLIB: '{rec.get('artistName', '')} - {rec.get('trackName', '')}')"
    return False, f"가수가 많이 달라요 (LRCLIB: '{rec.get('artistName', '')} - {rec.get('trackName', '')}')"


def decide(e, latest=None):
    """표를 세어 pick · avoid 를 다시 계산"""
    votes = {k: v for k, v in e.get('votes', {}).items() if v}
    wrong = {k: v for k, v in e.get('wrong', {}).items() if v}
    e['votes'], e['wrong'] = votes, wrong
    score = {k: len(v) - len(wrong.get(k, [])) for k, v in votes.items()}
    best = max(score.values(), default=0)
    cur = e.get('pick')
    pick = None
    if best > 0:
        tops = [k for k, s in score.items() if s == best]
        if cur is not None and str(cur) in tops:
            pick = int(cur)
        elif latest is not None and str(latest) in tops:
            pick = int(latest)
        else:
            pick = int(tops[0])
    if pick is None:
        e.pop('pick', None)
    else:
        e['pick'] = pick
    e['avoid'] = sorted(int(k) for k, v in wrong.items()
                        if int(k) > 0 and int(k) != pick and len(v) > len(votes.get(k, [])))
    return e


def tally(e):
    parts, wrong = [], e.get('wrong', {})
    for k, v in sorted(e.get('votes', {}).items(), key=lambda kv: -len(kv[1])):
        w = len(wrong.get(k, []))
        parts.append(f"{'가사 없음' if k == '0' else '#' + k} {len(v)}표" + (f" (틀림 {w}표)" if w else ''))
    return ', '.join(parts)


def _snap(e):
    return json.dumps({k: e.get(k) for k in ('votes', 'wrong', 'pick', 'avoid')}, sort_keys=True)


def apply_report(data, rep, user, issue_no, fetch, approved=False, today=None):
    """의견 하나를 data 에 반영 → (상태, 메시지). 상태: applied | review | invalid | locked
    issue_no: GitHub 이슈 번호 (앱 의견이면 None)"""
    song = (rep.get('song') or '').strip()[:200]
    artist = (rep.get('artist') or '').strip()[:200]
    if not norm(song):
        return 'invalid', '노래 제목이 비어 있어요.'
    wrong, correct = parse_id(rep.get('wrong_id')), parse_id(rep.get('correct_id'))
    if wrong == 'bad' or correct == 'bad':
        return 'invalid', '가사 번호는 숫자(또는 맞는 가사 번호에 none)로 적어 주세요.'
    if wrong == 0:
        wrong = None
    if not wrong and correct is None:
        return 'invalid', '틀린 가사 번호나 맞는 가사 번호 중 하나는 있어야 해요.'
    if correct and correct == wrong:
        return 'invalid', '틀린 가사와 맞는 가사가 같은 번호예요.'
    try:
        dur = float(rep.get('duration') or 0)
    except ValueError:
        dur = 0
    key = song_key(artist, song)
    songs = data.setdefault('songs', {})
    if songs.get(key, {}).get('locked'):
        return 'locked', '이 곡은 관리자가 가사를 고정해 두어서 바꾸지 않아요.'
    rec = None
    if correct:
        rec = fetch(correct)
        if not rec:
            return 'invalid', f'LRCLIB 에 #{correct} 가사가 없어요.'
        pair = f'{key}|{correct}'
        if not approved and pair not in data.get('approved', []):
            ok, why = check_record(rec, song, artist, dur)
            if not ok:
                return 'review', why
        if approved and pair not in data.setdefault('approved', []):
            data['approved'].append(pair)

    e = songs.setdefault(key, {'title': song, 'artist': artist})
    before = _snap(e)
    for book in ('votes', 'wrong'):          # 한 사람 한 표: 이 곡에 대한 이전 의견 지우기
        for k in list(e.get(book, {})):
            e[book][k] = [u for u in e[book][k] if u != user]
    if correct is not None:
        e.setdefault('votes', {}).setdefault(str(correct), []).append(user)
    if wrong:
        e.setdefault('wrong', {}).setdefault(str(wrong), []).append(user)
    decide(e, latest=correct)
    if issue_no:
        e['issues'] = (([n for n in e.get('issues', []) if n != issue_no]) + [issue_no])[-20:]
    if _snap(e) != before or issue_no:
        e['updated'] = today or datetime.date.today().isoformat()
    if not e.get('votes') and not e.get('wrong'):
        songs.pop(key, None)

    pick = e.get('pick')
    if correct is not None and pick == correct:
        what = '가사가 없는 곡으로 표시해요' if correct == 0 else \
            f"**{rec.get('artistName', '')} - {rec.get('trackName', '')}** 가사(LRCLIB #{correct})를 써요"
        msg = f'반영했어요. 이제 이 곡에서는 {what}.'
    elif correct is not None and pick is None:
        msg = f'의견을 기록했어요. 이 가사가 틀렸다는 의견도 있어서, 의견이 더 모이면 정해져요. (현재: {tally(e)})'
    elif correct is not None:
        msg = f'의견을 기록했어요. 지금은 다른 가사를 고른 사람이 같거나 더 많아서 그 가사를 계속 써요. (현재: {tally(e)})'
    else:
        msg = f'반영했어요. LRCLIB #{wrong} 가사는 이 곡에서 더 이상 자동으로 고르지 않아요.' if wrong in e.get('avoid', []) else \
            f'의견을 기록했어요. #{wrong} 가사가 맞다는 의견도 있어서 아직은 그대로 써요.'
    return 'applied', msg + '\n\n다른 사용자의 앱은 몇 시간 안에 새 목록을 받아요. 고마워요!'


def app_report(m):
    """앱이 보낸 의견(JSON) → (투표자, 양식 dict) · 형식이 이상하면 None"""
    if not isinstance(m, dict) or m.get('v') != 1:
        return None
    s, a, u = m.get('s'), m.get('a') or '', m.get('u')
    w, c, d = m.get('w'), m.get('c'), m.get('d') or 0
    ok_id = lambda x: x is None or (isinstance(x, int) and not isinstance(x, bool) and 0 <= x < 10 ** 9)
    if not (isinstance(s, str) and s.strip() and isinstance(a, str) and isinstance(u, str)):
        return None
    if not (re.fullmatch(r'[0-9a-f-]{16,64}', u) and ok_id(w) and ok_id(c) and isinstance(d, (int, float))):
        return None
    voter = 'a:' + hashlib.sha256(u.encode()).hexdigest()[:16]
    return voter, {'song': s, 'artist': a, 'duration': str(int(d)) if d else '',
                   'wrong_id': str(w) if w else '', 'correct_id': ('none' if c == 0 else str(c)) if c is not None else ''}


def review_body(rep, voter, why):
    """앱 의견이 확인이 필요할 때 만드는 이슈 본문 (이슈 양식과 같은 꼴 + 투표자 표시)"""
    v = lambda x: x if x else '_No response_'
    c = rep.get('correct_id')
    return (f"<!-- ullim-voter: {voter} -->\n앱 사용자가 고른 가사인데 확인이 필요해요: {why}\n"
            f"맞는 가사면 **`lyrics-approved` 라벨**을 붙여 주세요 → 자동으로 반영돼요. 틀렸으면 그냥 닫으면 돼요.\n"
            f"가사 보기: https://lrclib.net/api/get/{c}\n\n"
            f"### 노래 제목\n\n{rep['song']}\n\n### 가수\n\n{v(rep.get('artist'))}\n\n### 곡 길이(초)\n\n{v(rep.get('duration'))}\n\n"
            f"### 틀린 가사 번호\n\n{v(rep.get('wrong_id'))}\n\n### 맞는 가사 번호\n\n{v(c)}\n")


# ---------------------------------------------------------------- 파일 · 네트워크

def load_data(path=DATA):
    try:
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get('songs'), dict):
            return d
    except (OSError, ValueError):
        pass
    return {'version': 1, 'updated': '', 'songs': {}}


def save_data(d, path=DATA):
    d['version'] = 1
    d['updated'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')
    os.replace(tmp, path)


def http_json(url, method='GET', body=None, token=None):
    headers = {'User-Agent': UA, 'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
        headers['Accept'] = 'application/vnd.github+json'
        headers['X-GitHub-Api-Version'] = '2022-11-28'
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'null')
        except ValueError:
            return e.code, None


def lrclib_get(i):
    st, j = http_json(f'{LRCLIB}/get/{int(i)}')
    if st == 404:
        return None
    if st != 200:
        raise RuntimeError(f'LRCLIB 응답 {st}')
    return j


class GitHub:
    def __init__(self, repo, token):
        self.base, self.token = f'{GITHUB_API}/repos/{repo}', token

    def call(self, path, method='GET', body=None):
        st, j = http_json(self.base + path, method, body, self.token)
        if st >= 400 and not (method == 'POST' and path == '/labels' and st == 422):
            raise RuntimeError(f'GitHub {method} {path} → {st} {j}')
        return j

    def open_reports(self):
        out, page = [], 1
        while page <= 10:
            arr = self.call(f'/issues?state=open&per_page=100&sort=created&direction=asc&page={page}') or []
            for it in arr:
                if 'pull_request' in it:
                    continue
                labels = {l['name'] for l in it.get('labels', [])}
                if not ((it.get('title') or '').startswith(TITLE_PREFIX) or 'lyrics' in labels):
                    continue
                out.append(it)
            if len(arr) < 100:
                break
            page += 1
        return out

    def ensure_labels(self):
        for name, (color, desc) in LABELS.items():
            self.call('/labels', 'POST', {'name': name, 'color': color, 'description': desc})


# ---------------------------------------------------------------- 앱 의견 (ntfy 메시지함)

def ntfy_messages():
    """메시지함에 남아 있는(최근 12시간) 의견을 모두 읽기 → 시간 순"""
    req = urllib.request.Request(f'{NTFY_URL}/json?poll=1&since=all', headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read().decode('utf-8', 'replace')
    out = []
    for line in text.splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if isinstance(j, dict) and j.get('event') == 'message' and isinstance(j.get('message'), str):
            out.append(j)
    out.sort(key=lambda j: (j.get('time', 0), j.get('id', '')))
    return out


def apply_app_messages(data, msgs, fetch, todo, today=None):
    """앱 의견을 시간 순으로 반영. 어디까지 읽었는지(meta.ntfy)를 기억해 같은 의견을 두 번 세지 않는다.
    LRCLIB 이 안 되면 거기서 멈추고 다음 번에 이어서 한다."""
    old = (data.get('meta') or {}).get('ntfy') or {'time': 0, 'ids': []}
    cur = {'time': old.get('time', 0), 'ids': list(old.get('ids', []))}
    t0, seen = cur['time'], set(cur['ids'])
    per, done = {}, 0
    for j in msgs:
        t, mid = j.get('time', 0), j.get('id', '')
        if t < t0 or (t == t0 and mid in seen):
            continue
        r = None
        try:
            r = app_report(json.loads(j['message']))
        except ValueError:
            pass
        if r:
            voter, rep = r
            per[voter] = per.get(voter, 0) + 1
            if per[voter] <= MAX_PER_VOTER:
                try:
                    st, msg = apply_report(data, rep, voter, None, fetch, today=today)
                except Exception as e:  # LRCLIB 이 안 될 때 → 다음 번에 여기서부터
                    print(f'앱 의견 {mid}: 다음에 다시 ({e})')
                    break
                print(f'앱 의견 {mid} {voter}: {st} — {msg.splitlines()[0]}')
                if st == 'review':
                    pair = f"{song_key(rep['artist'], rep['song'])}|{parse_id(rep['correct_id'])}"
                    if pair not in data.setdefault('reviews', {}):
                        data['reviews'][pair] = today or datetime.date.today().isoformat()
                        title = f"[가사 확인] {rep['artist'] + ' - ' if rep['artist'] else ''}{rep['song']} → LRCLIB #{rep['correct_id']}"
                        todo.append({'type': 'review_issue', 'title': title[:200], 'body': review_body(rep, voter, msg)})
        if t > cur['time']:
            cur['time'], cur['ids'] = t, []
        cur['ids'].append(mid)
        done += 1
    if done:                                   # 새로 읽은 게 있을 때만 기록 (없으면 파일을 건드리지 않음)
        data.setdefault('meta', {})['ntfy'] = cur
    return done


# ---------------------------------------------------------------- 명령

def cmd_apply(out_path):
    gh = GitHub(os.environ['REPO'], os.environ['GH_TOKEN'])
    try:
        gh.ensure_labels()
    except RuntimeError as e:
        print('라벨 만들기 건너뜀:', e)
    data, todo = load_data(), []
    before = json.dumps(data, sort_keys=True)
    try:
        msgs = ntfy_messages()
    except Exception as e:  # 메시지함이 잠시 안 될 때 → 다음 번에 (12시간 보관)
        print('앱 의견 메시지함을 읽지 못함:', e)
        msgs = []
    print(f'앱 의견 {apply_app_messages(data, msgs, lrclib_get, todo)}건 읽음')
    for it in gh.open_reports():
        n, author = it['number'], it.get('user') or {}
        labels = {l['name'] for l in it.get('labels', [])}
        body = it.get('body') or ''
        if author.get('type') == 'Bot':      # 봇이 만든 확인용 이슈 → 원래 의견을 낸 앱 사용자의 표
            m = VOTER_MARK.search(body)
            if not m:
                continue
            user = m.group(1)
        elif author.get('login'):
            user = 'gh:' + author['login']
        else:
            continue
        rep = parse_form(body)
        approved = 'lyrics-approved' in labels
        if 'needs-review' in labels and not approved:     # 확인 대기: 같은 짝이 다른 제보로 승인됐을 때만 반영
            c = parse_id(rep.get('correct_id'))
            if not (isinstance(c, int) and f"{song_key(rep.get('artist', ''), rep.get('song', ''))}|{c}" in data.get('approved', [])):
                continue
        try:
            st, msg = apply_report(data, rep, user, n, lrclib_get, approved=approved)
        except Exception as e:  # LRCLIB 이 안 될 때 등 → 다음 번에 다시
            print(f'#{n}: 다음에 다시 ({e})')
            continue
        print(f'#{n} {user}: {st} — {msg.splitlines()[0]}')
        todo.append({'type': 'issue', 'issue': n, 'status': st, 'message': msg, 'labels': sorted(labels)})
    if json.dumps(data, sort_keys=True) != before:
        save_data(data)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(todo, f, ensure_ascii=False, indent=1)
    print(f'할 일 {len(todo)}건')


def cmd_report(path):
    gh = GitHub(os.environ['REPO'], os.environ['GH_TOKEN'])
    with open(path, encoding='utf-8') as f:
        todo = json.load(f)
    for t in todo:
        if t.get('type') == 'review_issue':
            gh.call('/issues', 'POST', {'title': t['title'], 'body': t['body'], 'labels': ['lyrics', 'needs-review']})
            continue
        n, st = t['issue'], t['status']
        if st == 'review':
            if 'needs-review' in t['labels']:
                continue
            gh.call(f'/issues/{n}/comments', 'POST', {'body': t['message'] + '\n\n관리자가 확인한 뒤 `lyrics-approved` 라벨을 붙이면 반영돼요.'})
            gh.call(f'/issues/{n}/labels', 'POST', {'labels': ['needs-review']})
            continue
        if st == 'applied' or st == 'locked':
            text = t['message']
        else:
            text = '제보 양식을 읽지 못했어요: ' + t['message'] + '\n앱의 가사 화면에서 직접 검색해 맞는 가사를 고르면 자동으로 알려져요.'
        gh.call(f'/issues/{n}/comments', 'POST', {'body': text})
        gh.call(f'/issues/{n}', 'PATCH', {'state': 'closed', 'state_reason': 'completed' if st == 'applied' else 'not_planned'})


def cmd_selftest():
    recs = {
        101: {'id': 101, 'trackName': 'LOVE DIVE', 'artistName': 'IVE'},
        102: {'id': 102, 'trackName': 'LOVE DIVE (Remix)', 'artistName': 'IVE'},
        200: {'id': 200, 'trackName': 'Dynamite', 'artistName': 'BTS'},
    }
    fetch = recs.get
    body = ('### 노래 제목\n\nLOVE DIVE\n\n### 가수\n\nIVE\n\n### 곡 길이(초)\n\n177\n\n'
            '### 틀린 가사 번호\n\n102\n\n### 맞는 가사 번호\n\n101\n\n### 하고 싶은 말\n\n_No response_\n\n### 앱 버전\n\n1.0.1')
    rep = parse_form(body)
    assert rep == {'song': 'LOVE DIVE', 'artist': 'IVE', 'duration': '177', 'wrong_id': '102', 'correct_id': '101',
                   'note': '', 'app_version': '1.0.1'}, rep
    d = {'songs': {}}
    st, msg = apply_report(d, rep, 'alice', 1, fetch, today='2026-11-04')
    key = song_key('IVE', 'LOVE DIVE')
    assert key == 'ive|lovedive', key
    e = d['songs'][key]
    assert st == 'applied' and e['pick'] == 101 and e['avoid'] == [102], (st, e)
    # 같은 사람이 다시: 이전 의견은 지워진다
    st, _ = apply_report(d, {'song': 'LOVE DIVE', 'artist': 'IVE', 'correct_id': '102'}, 'alice', 2, fetch)
    e = d['songs'][key]
    assert e['pick'] == 102 and e['avoid'] == [] and e['votes'] == {'102': ['alice']} and e['wrong'] == {}, e
    # bob 이 101 → 1:1 동점이라 102 유지, carol 이 101 + '102 틀림' → 101 이 이김
    apply_report(d, {'song': 'love dive', 'artist': 'ive', 'correct_id': '101'}, 'bob', 3, fetch)
    assert d['songs'][key]['pick'] == 102, d['songs'][key]
    apply_report(d, {'song': 'LOVE DIVE', 'artist': 'IVE', 'correct_id': '101', 'wrong_id': '102'}, 'carol', 4, fetch)
    e = d['songs'][key]
    assert e['pick'] == 101 and e['avoid'] == [], e      # 102 는 맞다 1 · 틀리다 1 → 빼지 않음
    # 동점이면 지금 pick 유지
    d2 = {'songs': {}}
    apply_report(d2, {'song': 'Dynamite', 'artist': 'BTS', 'correct_id': '200'}, 'a', 1, fetch)
    apply_report(d2, {'song': 'Dynamite', 'artist': 'BTS', 'correct_id': 'none'}, 'b', 2, fetch)
    e2 = d2['songs'][song_key('BTS', 'Dynamite')]
    assert e2['pick'] == 200, e2
    apply_report(d2, {'song': 'Dynamite', 'artist': 'BTS', 'correct_id': 'none'}, 'c', 3, fetch)
    assert e2['pick'] == 0, e2
    # 틀렸다고만
    d3 = {'songs': {}}
    st, msg = apply_report(d3, {'song': 'Dynamite', 'artist': 'BTS', 'wrong_id': '999'}, 'a', 1, fetch)
    assert st == 'applied' and d3['songs']['bts|dynamite']['avoid'] == [999] and 'pick' not in d3['songs']['bts|dynamite'], d3
    # 이상한 입력
    assert apply_report({}, {'song': '', 'correct_id': '1'}, 'a', 1, fetch)[0] == 'invalid'
    assert apply_report({}, {'song': 'x', 'correct_id': 'abc'}, 'a', 1, fetch)[0] == 'invalid'
    assert apply_report({}, {'song': 'x'}, 'a', 1, fetch)[0] == 'invalid'
    assert apply_report({}, {'song': 'x', 'correct_id': '555'}, 'a', 1, fetch)[0] == 'invalid'      # LRCLIB 에 없음
    assert apply_report({}, {'song': 'Butter', 'artist': 'BTS', 'correct_id': '101'}, 'a', 1, fetch)[0] == 'review'
    assert apply_report({}, {'song': 'Butter', 'artist': 'BTS', 'correct_id': '101'}, 'a', 1, fetch, approved=True)[0] == 'applied'
    # 열쇠 정규화
    assert norm('Ｈｅｌｌｏ (Live) [MV] feat. X') == 'hello', norm('Ｈｅｌｌｏ (Live) [MV] feat. X')
    assert norm('사랑을 했다 (LOVE SCENARIO)') == '사랑을했다'
    assert parse_id('#123') == 123 and parse_id('없음') == 0 and parse_id('') is None and parse_id('12a') == 'bad'

    # 곡 길이로 같은 곡 확인 (한글 제목 ↔ 영어 제목, 아이유 ↔ IU)
    rec = {'trackName': 'Love Scenario', 'artistName': 'iKON', 'duration': 211}
    assert check_record(rec, '사랑을 했다', 'iKON', 210)[0]
    assert not check_record(rec, '사랑을 했다', 'iKON', 230)[0]
    assert check_record({'trackName': '밤편지', 'artistName': 'IU', 'duration': 253}, '밤편지', '아이유', 254)[0]
    assert not check_record({'trackName': '밤편지', 'artistName': 'IU', 'duration': 253}, '밤편지', '아이유', 0)[0]

    # 앱 의견: 형식 확인 · 읽은 곳 기억 · 한 사람 상한 · 확인용 이슈는 한 번만
    u1, u2 = 'a' * 32, '0123456789abcdef0123456789abcdef'
    msg = lambda i, t, **k: {'id': i, 'time': t, 'event': 'message', 'message': json.dumps(dict({'v': 1, 'u': u1, 'a': '', 'd': 0, 'w': None, 'c': None}, **k), ensure_ascii=False)}
    assert app_report({'v': 1, 's': 'x', 'a': '', 'u': 'zz', 'c': 1}) is None                 # 이상한 투표자
    assert app_report({'v': 1, 's': 'x', 'a': '', 'u': u1, 'c': True}) is None                # bool 은 번호가 아님
    assert app_report({'v': 2, 's': 'x', 'a': '', 'u': u1, 'c': 1}) is None
    v1 = app_report({'v': 1, 's': 'x', 'a': '', 'u': u1, 'c': 0})
    assert v1[0].startswith('a:') and len(v1[0]) == 18 and v1[1]['correct_id'] == 'none', v1
    recs[300] = {'id': 300, 'trackName': 'Love Scenario', 'artistName': 'iKON', 'duration': 211}
    d4, todo = {'songs': {}}, []
    msgs = [msg('m1', 100, s='LOVE DIVE', a='IVE', c=101),
            msg('m2', 100, s='Dynamite', a='BTS', c=200, u=u2),
            msg('m3', 101, s='사랑을 했다', a='아이콘', c=300, d=211),          # 가수 표기가 달라 확인 필요
            msg('m4', 102, s='사랑을 했다', a='아이콘', c=300, d=211, u=u2),   # 같은 짝 → 이슈는 한 번만
            {'id': 'x', 'time': 103, 'event': 'message', 'message': 'not json'},
            {'id': 'k', 'time': 104, 'event': 'keepalive'}]
    assert apply_app_messages(d4, [m for m in msgs if m['event'] == 'message'], fetch, todo, today='2026-11-04') == 5
    assert d4['songs']['ive|lovedive']['pick'] == 101 and d4['songs']['bts|dynamite']['pick'] == 200, d4
    assert [t['type'] for t in todo] == ['review_issue'] and '#300' in todo[0]['title'] and 'ullim-voter: a:' in todo[0]['body'], todo
    assert d4['meta']['ntfy'] == {'time': 103, 'ids': ['x']}, d4['meta']
    # 다시 읽어도 두 번 세지 않음
    snap = json.dumps(d4, sort_keys=True)
    assert apply_app_messages(d4, [m for m in msgs if m['event'] == 'message'], fetch, [], today='2026-11-04') == 0
    assert json.dumps(d4, sort_keys=True) == snap
    # 관리자 승인 → 같은 짝의 다음 앱 의견은 바로 반영
    body = todo[0]['body']
    rep = parse_form(body)
    assert rep['song'] == '사랑을 했다' and rep['correct_id'] == '300', rep
    st, _ = apply_report(d4, rep, VOTER_MARK.search(body).group(1), 9, fetch, approved=True)
    assert st == 'applied' and d4['songs'][song_key('아이콘', '사랑을 했다')]['pick'] == 300
    st, _ = apply_report(d4, rep, 'a:ffffffffffffffff', None, fetch)
    assert st == 'applied' and len(d4['songs'][song_key('아이콘', '사랑을 했다')]['votes']['300']) == 2
    # 한 사람 상한
    d5 = {'songs': {}}
    many = [msg(f'n{i}', 200 + i, s=f'Song {i}', a='IVE', c=None, w=500 + i) for i in range(MAX_PER_VOTER + 5)]
    apply_app_messages(d5, many, fetch, [])
    assert len(d5['songs']) == MAX_PER_VOTER, len(d5['songs'])
    # LRCLIB 이 안 되면 거기서 멈춤 → 다음 번에 그 의견부터
    def broken(i):
        raise RuntimeError('down')
    d6 = {'songs': {}}
    assert apply_app_messages(d6, [msg('p1', 300, s='A', w=1), msg('p2', 301, s='B', c=7), msg('p3', 302, s='C', w=2)], broken, []) == 1
    assert d6['meta']['ntfy'] == {'time': 300, 'ids': ['p1']}, d6['meta']
    # 고정된 곡
    d7 = {'songs': {'ive|lovedive': {'title': 'LOVE DIVE', 'artist': 'IVE', 'pick': 101, 'locked': True}}}
    assert apply_report(d7, {'song': 'LOVE DIVE', 'artist': 'IVE', 'correct_id': '102'}, 'z', None, fetch)[0] == 'locked'
    assert d7['songs']['ive|lovedive']['pick'] == 101
    print('selftest ok')


if __name__ == '__main__':
    a = sys.argv[1:] or ['selftest']
    if a[0] == 'apply':
        cmd_apply(a[1] if len(a) > 1 else 'lyrics-actions.json')
    elif a[0] == 'report':
        cmd_report(a[1])
    elif a[0] == 'selftest':
        cmd_selftest()
    else:
        sys.exit(__doc__)
