#!/usr/bin/env python3
"""가사 제보 봇(.github/scripts/lyrics_feedback.py) 전체 흐름 시험 — 가짜 GitHub · LRCLIB 서버로.

  python3 test/lyrics_bot_test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, '.github', 'scripts', 'lyrics_feedback.py')


def form(song, artist='', wrong='', correct='', dur='200'):
    v = lambda x: x if x else '_No response_'
    return (f'### 노래 제목\n\n{song}\n\n### 가수\n\n{v(artist)}\n\n### 곡 길이(초)\n\n{v(dur)}\n\n'
            f'### 틀린 가사 번호\n\n{v(wrong)}\n\n### 맞는 가사 번호\n\n{v(correct)}\n\n'
            f'### 하고 싶은 말\n\n_No response_\n\n### 앱 버전\n\n1.0.1')


LRC = {
    11: {'id': 11, 'trackName': '밤편지', 'artistName': '아이유', 'albumName': 'Palette', 'duration': 253},
    12: {'id': 12, 'trackName': '밤편지 (Live)', 'artistName': '아이유', 'albumName': 'Live', 'duration': 260},
    21: {'id': 21, 'trackName': 'Hype Boy', 'artistName': 'NewJeans', 'duration': 179},
    31: {'id': 31, 'trackName': 'Completely Different', 'artistName': 'Someone', 'duration': 100},
    41: {'id': 41, 'trackName': 'Love Scenario', 'artistName': 'iKON', 'duration': 211},
}
ISSUES = [
    {'number': 1, 'title': '[가사] 아이유 - 밤편지', 'user': {'login': 'alice', 'type': 'User'},
     'labels': [{'name': 'lyrics'}], 'body': form('밤편지', '아이유', '12', '11')},
    {'number': 2, 'title': '[가사] NewJeans - Hype Boy', 'user': {'login': 'bob', 'type': 'User'},
     'labels': [], 'body': form('Hype Boy', 'NewJeans', '', 'none')},
    {'number': 3, 'title': '[가사] 엉뚱한 번호', 'user': {'login': 'carol', 'type': 'User'},
     'labels': [{'name': 'lyrics'}], 'body': form('Ditto', 'NewJeans', '', '31')},
    {'number': 4, 'title': '[가사] 깨진 양식', 'user': {'login': 'dave', 'type': 'User'},
     'labels': [{'name': 'lyrics'}], 'body': 'hello'},
    {'number': 5, 'title': '다른 이슈', 'user': {'login': 'erin', 'type': 'User'}, 'labels': [], 'body': form('x', 'y', '', '11')},
    {'number': 6, 'title': '[가사] 확인 대기', 'user': {'login': 'frank', 'type': 'User'},
     'labels': [{'name': 'lyrics'}, {'name': 'needs-review'}], 'body': form('Ditto', 'NewJeans', '', '31')},
    {'number': 7, 'title': '[가사] 관리자 승인', 'user': {'login': 'grace', 'type': 'User'},
     'labels': [{'name': 'lyrics'}, {'name': 'needs-review'}, {'name': 'lyrics-approved'}], 'body': form('Ditto', 'NewJeans', '', '31')},
    {'number': 8, 'title': '[가사] PR', 'user': {'login': 'h', 'type': 'User'}, 'labels': [], 'pull_request': {}, 'body': form('x', '', '', '11')},
    {'number': 9, 'title': '[가사 확인] 아이콘 - 사랑을 했다 → LRCLIB #41', 'user': {'login': 'github-actions[bot]', 'type': 'Bot'},
     'labels': [{'name': 'lyrics'}, {'name': 'needs-review'}, {'name': 'lyrics-approved'}],
     'body': '<!-- ullim-voter: a:00112233445566ff -->\n확인 필요\n\n' + form('사랑을 했다', '아이콘', '', '41', '211')},
    {'number': 10, 'title': '[가사 확인] 표시 없는 봇 이슈', 'user': {'login': 'github-actions[bot]', 'type': 'Bot'},
     'labels': [{'name': 'lyrics'}, {'name': 'lyrics-approved'}], 'body': form('x', '', '', '11')},
]
U1, U2 = '0f' * 16, 'ab' * 16
APP = [  # 앱이 메시지함에 보낸 의견 (ntfy 의 poll 응답 한 줄씩)
    {'id': 'm1', 'time': 1000, 'event': 'message', 'message': json.dumps({'v': 1, 's': 'Hype Boy', 'a': 'NewJeans', 'd': 179, 'w': None, 'c': 21, 'u': U1, 'app': '1.0.1'})},
    {'id': 'm2', 'time': 1001, 'event': 'message', 'message': json.dumps({'v': 1, 's': 'Hype Boy', 'a': 'NewJeans', 'd': 179, 'w': None, 'c': 21, 'u': U2, 'app': '1.0.1'})},
    {'id': 'm3', 'time': 1002, 'event': 'message', 'message': json.dumps({'v': 1, 's': '밤편지', 'a': '아이유', 'd': 253, 'w': 11, 'c': None, 'u': U2, 'app': '1.0.1'}, ensure_ascii=False)},
    {'id': 'm4', 'time': 1003, 'event': 'message', 'message': json.dumps({'v': 1, 's': '어떤 노래', 'a': '누군가', 'd': 100, 'w': None, 'c': 31, 'u': U1, 'app': '1.0.1'}, ensure_ascii=False)},
    {'id': 'm5', 'time': 1004, 'event': 'message', 'message': 'garbage'},
]
LOG = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'null')

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith('/lrclib/api/get/'):
            i = int(u.path.rsplit('/', 1)[1])
            return self._send(200, LRC[i]) if i in LRC else self._send(404, {'message': 'not found'})
        if u.path == '/ntfy/json':
            assert 'poll=1' in u.query and 'since=all' in u.query, u.query
            b = ('\n'.join(json.dumps(m, ensure_ascii=False) for m in APP) + '\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if u.path == '/gh/repos/o/r/issues':
            assert self.headers.get('Authorization') == 'Bearer TOKEN'
            return self._send(200, [i for i in ISSUES if i.get('state', 'open') == 'open'] if 'page=1' in u.query else [])
        self._send(404, {})

    def do_POST(self):
        u = urlparse(self.path)
        LOG.append(('POST', u.path, self._body()))
        if u.path.startswith('/gh/repos/o/r/issues/') and u.path.endswith('/labels'):
            n = int(u.path.split('/')[-2])
            for i in ISSUES:
                if i['number'] == n:
                    i['labels'] += [{'name': x} for x in LOG[-1][2]['labels']]
        if u.path == '/gh/repos/o/r/labels':
            return self._send(422 if LOG.count(('POST', u.path, LOG[-1][2])) > 1 else 201, {})
        self._send(201, {})

    def do_PATCH(self):
        u = urlparse(self.path)
        LOG.append(('PATCH', u.path, self._body()))
        n = int(u.path.rsplit('/', 1)[1])
        for i in ISSUES:
            if i['number'] == n:
                i['state'] = LOG[-1][2]['state']
        self._send(200, {})


def main():
    srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{srv.server_port}'
    tmp = tempfile.mkdtemp()
    data = os.path.join(tmp, 'overrides.json')
    with open(data, 'w', encoding='utf-8') as f:
        json.dump({'version': 1, 'updated': '', 'songs': {}}, f)
    env = dict(os.environ, GH_TOKEN='TOKEN', REPO='o/r', GITHUB_API_URL=base + '/gh', LRCLIB_API=base + '/lrclib/api',
               NTFY_URL=base + '/ntfy', OVERRIDES_PATH=data, PYTHONIOENCODING='utf-8')
    acts = os.path.join(tmp, 'acts.json')
    r = subprocess.run([sys.executable, '-I', SCRIPT, 'apply', acts], env=env, capture_output=True, text=True)
    print(r.stdout, r.stderr)
    assert r.returncode == 0
    d = json.load(open(data, encoding='utf-8'))
    s = d['songs']
    # 앱 의견 2표(21) vs GitHub 제보 1표(가사 없음) → 21
    assert s['newjeans|hypeboy']['pick'] == 21 and len(s['newjeans|hypeboy']['votes']['21']) == 2, s['newjeans|hypeboy']
    # 앱: '11 틀림' 1표 · GitHub: 11 맞음 1표 + '12 틀림' → 11 은 맞다 1 - 틀리다 1 = 0 점 → pick 없음, avoid 는 12 만
    assert 'pick' not in s['아이유|밤편지'] and s['아이유|밤편지']['avoid'] == [12], s['아이유|밤편지']
    assert s['newjeans|ditto']['pick'] == 31, s            # #7 관리자 승인으로 반영 (#3 은 확인 대기)
    assert s['아이콘|사랑을했다']['pick'] == 41 and s['아이콘|사랑을했다']['votes']['41'] == ['a:00112233445566ff'], s
    assert d['meta']['ntfy'] == {'time': 1004, 'ids': ['m5']}, d['meta']
    assert '누군가|어떤노래|31' in d['reviews'], d.get('reviews')
    assert d['updated'], d
    raw = json.load(open(acts, encoding='utf-8'))
    todo = {t['issue']: t['status'] for t in raw if t['type'] == 'issue'}
    assert todo == {1: 'applied', 2: 'applied', 3: 'review', 4: 'invalid', 7: 'applied', 9: 'applied'}, todo
    reviews = [t for t in raw if t['type'] == 'review_issue']
    assert len(reviews) == 1 and '어떤 노래' in reviews[0]['title'], reviews

    r = subprocess.run([sys.executable, '-I', SCRIPT, 'report', acts], env=env, capture_output=True, text=True)
    print(r.stdout, r.stderr)
    assert r.returncode == 0
    closed = {p.rsplit('/', 1)[1]: b['state_reason'] for m, p, b in LOG if m == 'PATCH'}
    assert closed == {'1': 'completed', '2': 'completed', '4': 'not_planned', '7': 'completed', '9': 'completed'}, closed
    made = [b for m, p, b in LOG if m == 'POST' and p == '/gh/repos/o/r/issues']
    assert len(made) == 1 and made[0]['labels'] == ['lyrics', 'needs-review'] and 'ullim-voter: a:' in made[0]['body'], made
    labeled = [(p, b) for m, p, b in LOG if m == 'POST' and p.endswith('/labels') and '/issues/' in p]
    assert labeled == [('/gh/repos/o/r/issues/3/labels', {'labels': ['needs-review']})], labeled
    comments = {p.split('/')[-2]: b['body'] for m, p, b in LOG if p.endswith('/comments')}
    assert set(comments) == {'1', '2', '3', '4', '7', '9'}, comments
    assert '의견이 더 모이면' in comments['1'] and '#11 1표 (틀림 1표)' in comments['1'], comments['1']
    assert '반영했어요' in comments['7'] and 'LRCLIB #31' in comments['7'], comments['7']
    assert '의견을 기록했어요' in comments['2'], comments['2']        # 앱 사용자 2명이 다른 가사를 골라 둠
    # 같은 상태로 한 번 더 돌려도 바뀌는 것 없음 (이미 읽은 앱 의견은 다시 세지 않음)
    before = open(data, encoding='utf-8').read()
    r = subprocess.run([sys.executable, '-I', SCRIPT, 'apply', acts], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    after = json.load(open(data, encoding='utf-8'))
    b4 = json.loads(before)['songs']
    changed = sorted(k for k in set(b4) | set(after['songs']) if b4.get(k) != after['songs'].get(k))
    # 바뀌는 건 하나뿐: 확인 대기였던 #3 · #6 이, 같은 짝(Ditto → #31)이 #7 로 승인된 뒤라 이번에 반영됨
    assert changed == ['newjeans|ditto'] and sorted(after['songs']['newjeans|ditto']['votes']['31']) == ['gh:carol', 'gh:frank', 'gh:grace'], changed
    todo2 = json.load(open(acts, encoding='utf-8'))
    assert [(t['type'], t.get('issue'), t.get('status')) for t in todo2] == [('issue', 3, 'applied'), ('issue', 6, 'applied')], todo2
    print(json.dumps(d, ensure_ascii=False, indent=1)[:900])
    print('lyrics bot e2e ok')
    srv.shutdown()


if __name__ == '__main__':
    main()
