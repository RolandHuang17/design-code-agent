"""Package the verified executable with tracked documentation, examples and review pages."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.config import user_variable


def package(exe, output):
    workspace = Path.cwd().resolve()
    output = output.resolve()
    manifest_path = Path('experiments/v02/build-final.json')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if hashlib.sha256(exe.read_bytes()).hexdigest() != manifest['exe_sha256']:
        raise ValueError('Executable does not match the verified final build manifest')
    archive_path = output.parent / 'DesignCodeAgent-v0.2.0-windows-x64.zip'
    if not output.is_relative_to(workspace / 'dist') or output.exists() or archive_path.exists():
        raise ValueError('Release output and ZIP must be new paths under workspace dist')
    output.mkdir(parents=True)
    names = subprocess.check_output(['git', 'ls-files', '-z']).decode('utf-8').split('\0')
    for name in filter(None, names):
        path = Path(name)
        if name in {'README.md', 'LICENSE'} or path.parts[0] in {'docs', 'examples', 'experiments'}:
            target = output / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    shutil.copyfile(exe, output / 'DesignCodeAgent.exe')
    shutil.copyfile(manifest_path, output / 'BUILD-MANIFEST.json')
    for folder, destination in [('benchmarks/smoke', 'examples/smoke'), ('benchmarks/library', 'examples/library-inputs')]:
        target = output / destination
        target.mkdir(parents=True, exist_ok=True)
        for source in Path(folder).glob('*.md'):
            shutil.copyfile(source, target / source.name)
    target = output / 'examples/inputs'
    target.mkdir(parents=True, exist_ok=True)
    for name in ('Architecture_Documentation.md', 'Architecture_View.md'):
        shutil.copyfile(name, target / name)
    (output / 'SHA256SUMS.txt').write_text(manifest['exe_sha256'] + '  DesignCodeAgent.exe\n', encoding='ascii')
    secrets = [user_variable(n).encode() for n in ('DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY') if user_variable(n)]
    files = sorted(p for p in output.rglob('*') if p.is_file())
    for path in files:
        data = path.read_bytes()
        if any(secret in data for secret in secrets) or re.search(rb'\bsk-[A-Za-z0-9]{20,}\b', data):
            raise ValueError('Credential pattern found; content not printed: ' + str(path))
    with zipfile.ZipFile(archive_path, 'x', zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, path.relative_to(output).as_posix())
    return {'zip': str(archive_path), 'files': len(files), 'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(package(args.exe, args.output), indent=2))
