import hashlib
import json
from pathlib import Path

from scripts.summarize_benchmark import summarize


def test_changed_or_extra_source_prevents_automatic_acceptance_claim(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    folder = Path('cohort')
    folder.mkdir()
    job = {'case': 'library', 'repair_rounds': 3, 'repeat': 1}
    (folder / 'manifest.json').write_text(json.dumps({'model': 'fixture', 'jobs': [job]}))
    (folder / 'results.json').write_text(json.dumps([{**job, 'status': 'checks_passed_requires_review', 'source_unchanged': True, 'run': 'run'}]))
    project = Path('run/project')
    project.mkdir(parents=True)
    (project / 'app.js').write_text('original')
    artifacts = Path('run/artifacts')
    artifacts.mkdir()
    report = {'status': 'checks_passed_requires_review', 'generation_origin': 'fresh', 'usage': [],
              'files': [{'path': 'app.js', 'sha256': hashlib.sha256(b'original').hexdigest()}],
              'checks': [{'profile': 'runtime', 'status': 'passed'}, {'profile': 'test', 'status': 'passed', 'output': '\u2139 pass 9\n\u2139 skipped 27\n'}]}
    (artifacts / 'report.json').write_text(json.dumps(report))
    row = summarize(folder)['trials'][0]
    assert row['automatic_acceptance_success'] is True
    assert row['project_test_counts']['test'] == {'pass': 9, 'skipped': 27}
    (project / 'extra.js').write_text('operator change')
    assert summarize(folder)['trials'][0]['automatic_acceptance_success'] is False
    (project / 'app.js').write_text('modified')
    assert len(summarize(folder)['trials'][0]['integrity_errors']) == 2
