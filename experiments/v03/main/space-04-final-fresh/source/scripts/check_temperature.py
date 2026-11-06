"""Independent HTTP acceptance. Keep this checker outside model inputs and projects."""
import argparse
import json
import math
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def evaluate(base_url):
    parsed = urlsplit(base_url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password:
        raise ValueError('Acceptance is restricted to a local HTTP server')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    results = []

    def request(path, body=None, raw=None):
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base_url.rstrip('/') + path, data=data,
                                     headers={'Content-Type': 'application/json'})
        try:
            with opener.open(req, timeout=5) as response:
                return response.status, response.read(200_000), response.headers.get('Content-Type', '')
        except urllib.error.HTTPError as error:
            return error.code, error.read(200_000), error.headers.get('Content-Type', '')

    def record(name, action):
        try:
            passed = bool(action())
            results.append({'check': name, 'status': 'passed' if passed else 'failed'})
        except Exception as error:
            results.append({'check': name, 'status': 'failed', 'error_type': type(error).__name__})

    def converted(value, source, target, expected):
        status, raw, _ = request('/api/convert', {'value': value, 'from': source, 'to': target})
        data = json.loads(raw)
        actual = data.get('value')
        return status == 200 and type(actual) in (int, float) and math.isfinite(actual) and data.get('unit') == target and math.isclose(actual, expected, rel_tol=1e-9, abs_tol=1e-7)

    def rejected(body=None, raw=None):
        status, result, _ = request('/api/convert', body, raw)
        data = json.loads(result)
        return status == 400 and isinstance(data.get('error'), str) and bool(data['error'].strip())

    record('health', lambda: (lambda r: r[0] == 200 and json.loads(r[1]).get('status') == 'ok')(request('/health')))
    record('browser HTML', lambda: (lambda r: r[0] == 200 and 'text/html' in r[2] and b'<html' in r[1].lower())(request('/')))
    for value, source, target, expected in [(0, 'C', 'F', 32), (212, 'F', 'C', 100), (273.15, 'K', 'C', 0),
                                            (-40, 'C', 'F', -40), (0, 'K', 'F', -459.67),
                                            (-459.67, 'F', 'K', 0), (12.75, 'C', 'C', 12.75),
                                            (1, 'C', 'F', 33.8)]:
        record(f'convert {value}{source} to {target}', lambda v=value, s=source, t=target, e=expected: converted(v, s, t, e))
    for name, body in [('missing fields', {}), ('numeric string', {'value': '10', 'from': 'C', 'to': 'F'}),
                        ('boolean value', {'value': True, 'from': 'C', 'to': 'F'}),
                        ('unknown unit', {'value': 10, 'from': 'c', 'to': 'F'}),
                        ('below absolute zero', {'value': -273.151, 'from': 'C', 'to': 'K'}),
                        ('invalid same-unit', {'value': -1, 'from': 'K', 'to': 'K'})]:
        record(name, lambda b=body: rejected(b))
    record('malformed JSON', lambda: rejected(raw=b'{bad json'))
    return {'kind': 'independent_temperature_http', 'status': 'passed' if all(r['status'] == 'passed' for r in results) else 'failed',
            'checks': results, 'limitations': ['HTTP checks do not establish browser interaction or arbitrary-project correctness']}


if __name__ == '__main__':
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    result = evaluate(args.base_url)
    if args.report.exists():
        parser.error('Report already exists; preserve earlier acceptance evidence')
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True))
    raise SystemExit(result['status'] != 'passed')
