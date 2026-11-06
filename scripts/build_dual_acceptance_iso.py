"""Build a new read-only VM ISO carrying both programs; no credentials are included."""
import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.config import user_variable


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--main-exe', required=True, type=Path)
    parser.add_argument('--prototype-exe', required=True, type=Path)
    parser.add_argument('--probe', required=True, type=Path)
    parser.add_argument('--pycdlib-dir', type=Path, default=Path('.local/iso-builder'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--staging', type=Path, required=True)
    args = parser.parse_args()
    workspace = Path.cwd().resolve()
    output, staging = args.output.resolve(), args.staging.resolve()
    allowed = workspace / '.local/vm'
    if output.exists() or staging.exists() or not output.is_relative_to(allowed) or not staging.is_relative_to(allowed):
        parser.error('Output and staging must be new paths under workspace .local/vm')
    sources = {'Main/DesignCodeAgent.exe': args.main_exe, 'Prototype/DesignCodeAgent-Superagent.exe': args.prototype_exe,
               'EnvironmentProbe.exe': args.probe}
    for track in ('Main', 'Prototype'):
        for case in ('smoke', 'temperature-converter', 'superagent-health'):
            for path in (Path('benchmarks') / case).glob('*.md'):
                sources[f'{track}/examples/{case}/{path.name}'] = path
        for name in ('Architecture_Documentation.md', 'Architecture_View.md'):
            sources[f'{track}/examples/inputs/{name}'] = Path(name)
    secrets = [user_variable(name).encode() for name in ('DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY') if user_variable(name)]
    for name, path in sources.items():
        if not path.is_file():
            parser.error('Missing source: ' + name)
        data = path.read_bytes()
        if any(secret in data for secret in secrets) or re.search(rb'\bsk-[A-Za-z0-9]{20,}\b', data):
            parser.error('Credential pattern found; contents not printed: ' + name)
    sys.path.insert(0, str(args.pycdlib_dir.resolve()))
    import pycdlib
    staging.mkdir(parents=True)
    manifest = {}
    for name, path in sources.items():
        target = staging / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        manifest[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    (staging / 'SHA256SUMS.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3, joliet=3, vol_ident='DCA_V03_ACCEPT')
    prefix = '/中文 空格'
    iso.add_directory(iso_path='/ACCEPTANCE', joliet_path=prefix)
    folders = {Path('.'): '/ACCEPTANCE'}
    for index, path in enumerate(sorted((p for p in staging.rglob('*') if p.is_dir()), key=lambda p: (len(p.parts), str(p))), 1):
        relative = path.relative_to(staging)
        name = folders[relative.parent] + '/D%06d' % index
        iso.add_directory(iso_path=name, joliet_path=prefix + '/' + relative.as_posix())
        folders[relative] = name
    for index, path in enumerate(sorted(p for p in staging.rglob('*') if p.is_file()), 1):
        relative = path.relative_to(staging)
        iso.add_file(str(path), iso_path=folders[relative.parent] + '/F%06d.DAT;1' % index,
                     joliet_path=prefix + '/' + relative.as_posix())
    iso.write(str(output))
    iso.close()
    print(json.dumps({'path': str(output), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'files': len(manifest) + 1}))


if __name__ == '__main__':
    main()
