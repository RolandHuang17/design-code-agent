"""Package both new programs without overwriting historical releases; acceptance is never inferred."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.config import user_variable
from codeagent import __version__
from codeagent.safety import project_files


def package(main_exe, prototype_exe, output, evidence_roots=(), *, bundle_version=__version__):
    if not re.fullmatch(r'\d+\.\d+\.\d+', bundle_version):
        raise ValueError('Bundle version must be major.minor.patch')
    workspace = Path.cwd().resolve()
    output = output.resolve()
    if output.exists() or not output.is_relative_to(workspace / 'dist'):
        raise ValueError('Output must be a NEW archive under workspace dist')
    entries = {}
    for name, path in [('main/DesignCodeAgent.exe', main_exe), ('prototype/DesignCodeAgent-Superagent.exe', prototype_exe)]:
        path = path.resolve()
        if not path.is_file() or not path.is_relative_to(workspace / 'dist') or path.is_symlink():
            raise ValueError('Executables must be real files under workspace dist')
        entries[name] = path
    for name in ('README.md', 'LICENSE', 'NOTICE.md'):
        entries[name] = workspace / name
    for folder in (Path('docs'), Path('benchmarks/temperature-converter'),
                   Path('examples/temperature-converter'), Path('examples/superagent-health'), *evidence_roots):
        folder = folder.resolve()
        if not folder.exists() or not folder.is_relative_to(workspace) or folder.is_symlink():
            raise ValueError('Documentation/evidence root missing or outside workspace')
        for path in project_files(folder) if folder.is_dir() else [folder]:
            if not path.resolve().is_relative_to(workspace):
                raise ValueError('Outside evidence path')
            if path.name == '.env' or path.name.startswith('~$'):
                raise ValueError('Private or temporary file in evidence')
            entries[path.relative_to(workspace).as_posix()] = path
    for name in ('Architecture_Documentation.md', 'Architecture_View.md'):
        for track in ('main', 'prototype'):
            entries[f'{track}/examples/inputs/{name}'] = workspace / name
    for case in ('temperature-converter', 'superagent-health', 'library'):
        source = workspace / 'benchmarks' / case
        if source.is_dir():
            for path in source.glob('*.md'):
                for track in ('main', 'prototype'):
                    entries[f'{track}/examples/{case}/{path.name}'] = path
    secrets = [user_variable(name).encode() for name in ('DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY') if user_variable(name)]
    manifest = {'bundle': bundle_version, 'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                'policy': 'Two independent programs. Read acceptance evidence for each; presence in archive does not establish verification.', 'files': {}}
    for name, path in sorted(entries.items()):
        data = path.read_bytes()
        if any(secret in data for secret in secrets) or re.search(rb'\bsk-[A-Za-z0-9]{20,}\b', data):
            raise ValueError('Credential pattern found; content not printed: ' + name)
        manifest['files'][name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as archive:
            for name, path in sorted(entries.items()):
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != manifest['files'][name]['sha256']:
                    raise RuntimeError('Source changed during packaging: ' + name)
                archive.writestr(name, data)
            archive.writestr('BUNDLE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8'))
            sums = ''.join(f'{item["sha256"]}  {name}\n' for name, item in manifest['files'].items())
            archive.writestr('SHA256SUMS.txt', sums.encode('utf-8'))
    except Exception:
        output.unlink(missing_ok=True)
        raise
    # Read back every member rather than trusting only the archive creation call.
    with zipfile.ZipFile(output) as archive:
        for name, item in manifest['files'].items():
            if hashlib.sha256(archive.read(name)).hexdigest() != item['sha256']:
                raise RuntimeError('Archive verification failed: ' + name)
    return {'archive': str(output), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'files': len(entries)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--main-exe', required=True, type=Path)
    parser.add_argument('--prototype-exe', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--evidence', nargs='*', default=[], type=Path)
    parser.add_argument('--bundle-version', default=__version__)
    args = parser.parse_args()
    print(json.dumps(package(args.main_exe, args.prototype_exe, args.output, args.evidence, bundle_version=args.bundle_version), indent=2))
