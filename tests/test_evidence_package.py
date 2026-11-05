import json
import zipfile
from pathlib import Path

import pytest

from scripts.package_evidence import package


def test_evidence_archive_preserves_bytes_and_excludes_dependencies(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr('scripts.package_evidence.user_variable', lambda name: '')
    source = Path('run/project')
    (source / 'node_modules').mkdir(parents=True)
    (source / 'input.md').write_bytes(b'original\r\nbytes\r\n')
    (source / 'node_modules/dependency.js').write_text('excluded')
    result = package(Path('dist/evidence.zip'), [Path('run')])
    assert result['files'] == 1
    with zipfile.ZipFile('dist/evidence.zip') as archive:
        assert archive.read('run/project/input.md') == b'original\r\nbytes\r\n'
        assert len(json.loads(archive.read('ARCHIVE-MANIFEST.json'))['files']) == 1
    with pytest.raises(ValueError, match='NEW archive'):
        package(Path('dist/evidence.zip'), [Path('run')])


def test_evidence_packaging_blocks_configured_secret_before_archive_creation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr('scripts.package_evidence.user_variable', lambda name: 'private-fixture-credential')
    Path('run').mkdir()
    Path('run/events.jsonl').write_text('private-fixture-credential')
    with pytest.raises(ValueError, match='content not printed') as error:
        package(Path('dist/evidence.zip'), [Path('run')])
    assert 'private-fixture-credential' not in str(error.value)
    assert not Path('dist/evidence.zip').exists()
