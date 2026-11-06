"""Read-only v0.3 evidence index; never rewrites raw reports or older experiments."""
import argparse
import hashlib
import html
import json
from pathlib import Path
from urllib.parse import quote


EVIDENCE_NAMES = {'report.json', 'manifest.json', 'receipt.json', 'diagnosis.json', 'browser.json',
                  'manifest-start.json', 'summary.json', 'build-final.json', 'clean-windows.json', 'interruption.json'}
EXCLUDED_PARTS = {'node_modules', '.git', '.venv', '__pycache__', 'project', 'source', 'stages', 'candidates', 'revisions', 'inputs'}


def evidence_files(root):
    for path in sorted(root.rglob('*.json')):
        relative = path.relative_to(root)
        if any(part in EXCLUDED_PARTS for part in relative.parts[:-1]) or path.is_symlink():
            continue
        if path.name in EVIDENCE_NAMES or path.name.startswith('independent'):
            yield path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize(root):
    root = root.resolve()
    rows = []
    for path in evidence_files(root):
        try:
            report = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(report, dict):
                raise ValueError('report is not an object')
            prototype = report.get('prototype') is True
            run = report.get('run') if prototype and isinstance(report.get('run'), dict) else report
            checks = run.get('checks', [])
            if not isinstance(checks, list):
                checks = []
            checks = [c for c in checks if isinstance(c, dict)]
            normalized_checks = []
            for check in checks:
                result = check.get('result') if prototype and isinstance(check.get('result'), dict) else check
                status = ('passed' if result['passed'] else 'failed') if type(result.get('passed')) is bool else result.get('status', 'unverified')
                if prototype and check.get('state') != 'completed':
                    status = 'unverified' if check.get('state') in ('stale', 'running', 'interrupted') else 'failed'
                normalized_checks.append({'profile': result.get('profile', check.get('profile', result.get('check', 'unknown'))),
                                          'status': status, **({'job_state': check.get('state')} if prototype else {})})
            recorded_status = run.get('state', 'unclassified') if prototype else report.get('status', 'unclassified')
            if recorded_status == 'unclassified' and type(report.get('passed')) is bool:
                recorded_status = 'passed' if report['passed'] else 'failed'
            interruption = next((p for p in path.parents if p != root and p.is_relative_to(root) and (p / 'interruption.json').exists()), None)
            effective_status = 'interrupted' if recorded_status == 'running' and interruption else recorded_status
            rows.append({'report': path.relative_to(root).as_posix(), 'sha256': digest(path),
                         'record_kind': report.get('kind', path.stem),
                         'program': 'prototype' if prototype else 'main_or_independent_acceptance',
                         'status': effective_status, 'recorded_status': recorded_status,
                         'verification': run.get('verification', 'not_recorded'),
                         'generation_origin': report.get('generation_origin', 'not_recorded'),
                         'turns': report.get('turns'), 'estimated_cny': report.get('run_estimated_cny'),
                         'checks': normalized_checks,
                         'details': {key: report[key] for key in ('failure', 'root_cause_observed', 'independent_acceptance',
                                    'runtime_checks', 'source_unchanged', 'source_matches_original_run', 'cleanup',
                                    'limitations', 'policy', 'source_commit', 'source_unchanged_rechecked') if key in report},
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
        link = html.escape(quote(row['report'], safe='/'), quote=True)
        cards.append(f'<details><summary>{name} — {html.escape(str(row["status"]))}</summary><p><a href="{link}">Open original JSON</a></p><pre>{details}</pre></details>')
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
