"""Copy a closed run and its frozen controller bytes without rewriting evidence."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.config import user_variable
from codeagent.safety import project_files


def archive(controller, trial, run, destination):
    workspace = Path.cwd().resolve()
    destination = destination.resolve()
    if not destination.is_relative_to(workspace / 'experiments/v03'):
        raise ValueError('Archive must remain in experiments/v03')
    manifest = json.loads((trial / 'manifest.json').read_text(encoding='utf-8'))
    secrets = [s.encode() for name in ('DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY') if (s := user_variable(name))]
    copied = {}
    def put(relative, data):
        if any(secret in data for secret in secrets):
            raise ValueError('Configured credential found; contents not printed: ' + relative)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(data).hexdigest()
        if target.exists():
            if target.read_bytes() != data:
                raise ValueError('Refusing to overwrite different evidence: ' + relative)
        else:
            with target.open('xb') as stream:
                stream.write(data)
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Archive readback failed')
        copied[relative] = digest
    for path in trial.iterdir():
        if path.is_file() and path.suffix == '.json' and path.name != 'archive-manifest.json':
            put(path.name, path.read_bytes())
    for path in project_files(run):
        put('raw/' + run.name + '/' + path.relative_to(run).as_posix(), path.read_bytes())
    for name, expected in manifest['source_hashes'].items():
        repository_name = name if name.startswith(('codeagent/', 'benchmarks/', 'scripts/')) or name.startswith('Architecture_') else 'codeagent/' + name
        path = controller / repository_name
        data = path.read_bytes() if path.exists() else b''
        if hashlib.sha256(data).hexdigest() != expected:
            data = subprocess.check_output(['git', 'show', manifest['source_commit'] + ':' + repository_name], cwd=controller)
        if hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError('Frozen source bytes differ from recorded hash: ' + name)
        put('source/' + repository_name, data)
    summary = {'source_commit': manifest['source_commit'], 'files': copied,
               'copy_readback_verified': True, 'policy': 'Raw bytes preserved; derived acceptance is separate'}
    target = destination / 'archive-manifest.json'
    encoded = json.dumps(summary, ensure_ascii=False, indent=2).encode('utf-8')
    if target.exists() and target.read_bytes() != encoded:
        raise ValueError('Existing archive manifest differs; preserve it and use a new destination')
    if not target.exists():
        target.write_bytes(encoded)
    return {'archive': str(destination), 'copied_files': len(copied), 'verified': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('controller', 'trial', 'run', 'destination'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(archive(args.controller.resolve(), args.trial.resolve(), args.run.resolve(), args.destination)))
