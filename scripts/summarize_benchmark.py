"""Read-only cohort summary; includes every recorded outcome and verifies final file hashes."""
import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.safety import project_files


def resolve_run(value):
    """Use recorded location locally, or the same runs tree after evidence extraction elsewhere."""
    original = Path(value)
    if original.is_dir():
        return original
    normalized = str(value).replace('\\', '/')
    if '/runs/' in normalized:
        return Path('runs') / normalized.split('/runs/', 1)[1]
    return original


def summarize(folder):
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    results = json.loads((folder / 'results.json').read_text(encoding='utf-8'))
    rows = []
    for result in results:
        row = dict(result)
        run = resolve_run(result['run']) if result.get('run') else None
        report_path = run / 'artifacts/report.json' if run else None
        if report_path and report_path.exists():
            report = json.loads(report_path.read_text(encoding='utf-8'))
            usage = report.get('usage')
            if usage is None and (run / 'artifacts/usage.json').exists():
                usage = json.loads((run / 'artifacts/usage.json').read_text(encoding='utf-8')).get('requests', [])
            row['valid_usage_estimate_cny'] = round(sum(u['estimated_cny'] for u in usage or []), 6)
            row['final_manifest_available'] = 'files' in report
            row['integrity_errors'] = []
            if 'files' in report:
                expected = {item['path'] for item in report['files']}
                actual = {p.relative_to(run / 'project').as_posix() for p in project_files(run / 'project')}
                row['integrity_errors'] += [name + ': unrecorded extra file' for name in sorted(actual - expected)]
            for item in report.get('files', []):
                path = (run / 'project' / item['path']).resolve()
                if not path.is_relative_to((run / 'project').resolve()):
                    row['integrity_errors'].append(item['path'] + ': outside project')
                elif not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
                    row['integrity_errors'].append(item['path'] + ': missing/changed')
            row['project_test_counts'] = {}
            row['runtime_check_counts'] = {}
            for check in report.get('checks', []):
                if check.get('profile') in ('test', 'integration'):
                    counts = {k: int(v) for k, v in re.findall(r'(?:^|\n)(?:#|\u2139)\s*(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)', check.get('output', ''))}
                    row['project_test_counts'][check['profile']] = counts or {'counts': 'not parsed; inspect raw output'}
                if check.get('profile') == 'runtime':
                    row['runtime_check_counts'] = dict(Counter(c['status'] for c in check.get('checks', [])))
            row['automatic_acceptance_success'] = (
                result.get('source_unchanged') is True and report.get('generation_origin') == 'fresh'
                and report.get('status') == 'checks_passed_requires_review' and not row['integrity_errors']
                and any(c.get('profile') == 'runtime' and c.get('status') == 'passed' for c in report.get('checks', [])))
        rows.append(row)
    groups = []
    for case, rounds in sorted({(j['case'], j['repair_rounds']) for j in manifest['jobs']}):
        selected = [r for r in rows if (r['case'], r['repair_rounds']) == (case, rounds)]
        groups.append({'case': case, 'repair_rounds': rounds, 'planned': sum(j['case'] == case and j['repair_rounds'] == rounds for j in manifest['jobs']),
                       'recorded': len(selected), 'outcomes': dict(Counter(r['status'] for r in selected)),
                       'automatic_acceptance_successes': sum(r.get('automatic_acceptance_success', False) for r in selected),
                       'valid_usage_estimate_cny': round(sum(r.get('valid_usage_estimate_cny', 0) for r in selected), 6)})
    return {'cohort': folder.name, 'model': manifest['model'], 'groups': groups, 'trials': rows,
            'limitations': ['Small sample; no significance or general success-rate claim.',
                           'Cost is valid-response usage estimate only. Unknown request reservations remain in the separate global ledger.',
                           'Final hashes detect edits to recorded files; extra acceptance and semantic review remain necessary.']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cohort', type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(args.cohort), ensure_ascii=False, indent=2))
