"""Temporary loopback-only receiver for guest-selected evidence; stores bytes without extracting or executing them."""
import argparse
import hashlib
import html
import json
import secrets
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to(Path('.local/vm').resolve()):
        raise ValueError('Receiver output must remain under .local/vm')
    output.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(18)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path != '/' + token:
                self.send_error(404)
                return
            data = ('<!doctype html><meta charset="utf-8"><title>Guest evidence transfer</title>'
                    '<h1>Transfer selected evidence to the host</h1><p>Choose the environment report or a ZIP of the run directory. Never select API key files.</p>'
                    '<input id="file" type="file"><button id="send">Upload selected file</button><pre id="result"></pre>'
                    '<script>document.getElementById("send").onclick=async()=>{let f=document.getElementById("file").files[0];if(!f)return;'
                    'let r=await fetch(location.pathname,{method:"POST",headers:{"X-Evidence-Name":encodeURIComponent(f.name)},body:f});'
                    'document.getElementById("result").textContent=await r.text();};</script>').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path != '/' + token:
                self.send_error(404)
                return
            from urllib.parse import unquote
            name = unquote(self.headers.get('X-Evidence-Name', ''))
            if not name or Path(name).name != name or '/' in name or '\\' in name or Path(name).suffix.lower() not in ('.zip', '.txt', '.json'):
                self.send_error(400)
                return
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 64 * 1024 * 1024:
                self.send_error(413)
                return
            self.connection.settimeout(30)
            data = self.rfile.read(size)
            if len(data) != size:
                self.send_error(400)
                return
            target = output / (secrets.token_hex(4) + '-' + name)
            with target.open('xb') as stream:
                stream.write(data)
            digest = hashlib.sha256(data).hexdigest()
            result = json.dumps({'saved': target.name, 'bytes': size, 'sha256': digest}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(result)))
            self.end_headers()
            self.wfile.write(result)
            print(result.decode(), flush=True)

    server = HTTPServer(('127.0.0.1', args.port), Handler)
    print(json.dumps({'guest_url': f'http://10.0.2.2:{args.port}/{token}', 'bind': '127.0.0.1', 'output': str(output)}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
