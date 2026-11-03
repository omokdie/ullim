"""Dev server with HTTP Range support (mimics the app's /media endpoint)."""
import http.server, os, re, sys, urllib.parse, mimetypes

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('audio/flac', '.flac')
mimetypes.add_type('audio/ogg', '.opus')
mimetypes.add_type('audio/mp4', '.m4a')


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def send_file(self, path):
        if not os.path.isfile(path):
            self.send_error(404); return
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        rng = self.headers.get('Range')
        start, end = 0, size - 1
        status = 200
        if rng:
            m = re.match(r'bytes=(\d*)-(\d*)', rng)
            if m:
                if m.group(1):
                    start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                status = 206
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk: break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/media':
            q = urllib.parse.parse_qs(u.query)
            p = (q.get('p') or q.get('u') or [''])[0]
            return self.send_file(p)
        path = os.path.join(ROOT, urllib.parse.unquote(u.path).lstrip('/'))
        if os.path.isdir(path):
            path = os.path.join(path, 'index.html')
        return self.send_file(path)


http.server.ThreadingHTTPServer.allow_reuse_address = True
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
