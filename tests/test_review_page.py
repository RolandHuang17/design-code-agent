import json
from pathlib import Path

from scripts.render_review import render


def test_untrusted_runtime_output_cannot_add_active_html(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    folder = Path('cohort')
    folder.mkdir()
    job = {'case': 'library', 'repair_rounds': 0, 'repeat': 1}
    (folder / 'manifest.json').write_text(json.dumps({'model': 'fixture', 'jobs': [job]}))
    (folder / 'results.json').write_text(json.dumps([{**job, 'trial': 1, 'status': 'failed', 'run': 'run'}]))
    artifacts = Path('run/artifacts')
    artifacts.mkdir(parents=True)
    payload = '<script>alert("untrusted")</script>'
    (artifacts / 'report.json').write_text(json.dumps({'checks': [{'profile': 'runtime', 'status': 'failed', 'error': payload}]}))
    document = render(folder)
    assert '<script>' not in document
    assert '&lt;script&gt;' in document
    assert '未形成最终清单' in document
