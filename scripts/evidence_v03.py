"""Read-only v0.3 evidence index; never rewrites raw reports or older experiments."""
import argparse
import hashlib
import html
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize(root):
    root = root.resolve()
    rows = []
    for path in sorted(root.rglob('report.json')):
        if 'node_modules' in path.parts or '.git' in path.parts:
            continue
        try:
            report = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(report, dict):
                raise ValueError('report is not an object')
            checks = report.get('checks', [])
            if not isinstance(checks, list):
                checks = []
            checks = [c for c in checks if isinstance(c, dict)]
            rows.append({'report': path.relative_to(root).as_posix(), 'sha256': digest(path),
                         'status': report.get('status', 'unclassified'),
                         'generation_origin': report.get('generation_origin', 'not_recorded'),
                         'turns': report.get('turns'), 'estimated_cny': report.get('run_estimated_cny'),
                         'checks': [{'profile': c.get('profile', c.get('check', 'unknown')), 'status': c.get('status', 'unverified')}
                                    for c in checks],
                         'independent_acceptance': 'Only separately recorded operator acceptance establishes this; not inferred from model text'})
        except (ValueError, OSError) as error:
            rows.append({'report': path.relative_to(root).as_posix(), 'status': 'unreadable', 'error_type': type(error).__name__})
    return {'scope': 'v0.3 only; main-tool trials and architecture-prototype demos remain separate',
            'policy': 'All discovered reports are listed, including failures and interruptions. No general success-rate claim.',
            'reports': rows}


def render(data):
    cards = []
    for row in data['reports']:
        name = html.escape(row['report'])
        details = html.escape(json.dumps(row, ensure_ascii=False, indent=2))
        cards.append(f'<details><summary>{name} — {html.escape(str(row["status"]))}</summary><pre>{details}</pre></details>')
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>v0.3 evidence index</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:16px}details{margin:12px 0;padding:12px;border:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>v0.3 evidence index</h1><p>' + html.escape(data['policy']) + '</p>' + ''.join(cards) + '</html>'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists() or args.output.with_suffix('.json').exists():
        parser.error('Index output must be new; preserve earlier indexes')
    data = summarize(args.root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render(data), encoding='utf-8')
    args.output.with_suffix('.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
