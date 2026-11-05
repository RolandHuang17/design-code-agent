"""Archive v0.2 raw evidence byte-for-byte after checking configured credentials; never includes dependencies."""
import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.config import user_variable
from codeagent.safety import project_files


def package(output, roots):
    workspace = Path.cwd().resolve()
    output = output.resolve()
    if not output.is_relative_to(workspace / 'dist') or output.exists():
        raise ValueError('Output must be a NEW archive under this workspace dist directory')
    secrets = [user_variable(name).encode() for name in ('DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY') if user_variable(name)]
    entries = {}
    for root in roots:
        root = root.resolve()
        if not root.is_relative_to(workspace) or not root.exists():
            raise ValueError('Evidence root missing or outside workspace')
        for path in project_files(root) if root.is_dir() else [root]:
            if path.is_symlink() or not path.resolve().is_relative_to(workspace):
                raise ValueError('Evidence contains an outside link')
            if path == output:
                raise ValueError('Archive cannot include itself')
            name = path.relative_to(workspace).as_posix()
            if path.name == '.env' or path.name.startswith('~$'):
                raise ValueError(f'Private or temporary file: {name}')
            data = path.read_bytes()
            if any(secret in data for secret in secrets) or re.search(rb'\bsk-[A-Za-z0-9]{20,}\b', data):
                raise ValueError(f'Credential pattern found; content not printed: {name}')
            entries[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'path': path}
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as archive:
        for name, item in sorted(entries.items()):
            data = item['path'].read_bytes()
            if hashlib.sha256(data).hexdigest() != item['sha256']:
                raise RuntimeError(f'Evidence changed during packaging: {name}')
            archive.writestr(name, data)
        manifest = {'policy': 'Byte-preserved evidence; node_modules, VCS and Python caches excluded. Inspect each run status and seed lineage.',
                    'files': {name: {k: v for k, v in item.items() if k != 'path'} for name, item in sorted(entries.items())}}
        archive.writestr('ARCHIVE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8'))
    return {'path': str(output), 'files': len(entries), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('roots', nargs='+', type=Path)
    args = parser.parse_args()
    print(json.dumps(package(args.output, args.roots), indent=2))
