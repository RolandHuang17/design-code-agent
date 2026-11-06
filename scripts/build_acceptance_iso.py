"""Build read-only VM acceptance media. pycdlib is an isolated developer tool, not an app dependency."""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pycdlib-dir', type=Path, default=Path('.local/iso-builder'))
    parser.add_argument('--output', type=Path, default=Path('.local/vm/DesignCodeAgent-Acceptance.iso'))
    parser.add_argument('--exe', type=Path, default=Path('dist/v0.2.0/DesignCodeAgent.exe'))
    parser.add_argument('--folder', default='中文 空格')
    args = parser.parse_args()
    sys.path.insert(0, str(args.pycdlib_dir.resolve()))
    import pycdlib
    root = Path('.local/vm/acceptance-media')
    agent = root / 'Agent'
    agent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.exe, agent / 'DesignCodeAgent.exe')
    for case in ('smoke', 'library'):
        target = agent / 'examples' / case
        target.mkdir(parents=True, exist_ok=True)
        for source in (Path('benchmarks') / case).glob('*.md'):
            shutil.copyfile(source, target / source.name)
    original = agent / 'examples/inputs'
    original.mkdir(exist_ok=True)
    for name in ('Architecture_Documentation.md', 'Architecture_View.md'):
        shutil.copyfile(name, original / name)
    if not (root / 'EnvironmentProbe.exe').is_file():
        raise RuntimeError('Compile windows_environment_probe.cs first')
    shutil.copyfile('scripts/windows_environment_probe.cs', root / 'EnvironmentProbe.cs')
    files = sorted(p for p in root.rglob('*') if p.is_file())
    manifest = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files if p.name != 'SHA256SUMS.json'}
    (root / 'SHA256SUMS.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    iso = pycdlib.PyCdlib()
    iso.new(interchange_level=3, joliet=3, vol_ident='DCA_ACCEPTANCE')
    if not args.folder or '/' in args.folder or '\\' in args.folder:
        raise ValueError('Folder must be a single directory name')
    prefix = '/' + args.folder
    iso.add_directory(iso_path='/ACCEPTANCE', joliet_path=prefix)
    iso_dirs = {Path('.'): '/ACCEPTANCE'}
    for index, path in enumerate(sorted((p for p in root.rglob('*') if p.is_dir()), key=lambda p: (len(p.parts), str(p))), 1):
        relative = path.relative_to(root)
        name = iso_dirs[relative.parent] + '/D%06d' % index
        iso.add_directory(iso_path=name, joliet_path=prefix + '/' + relative.as_posix())
        iso_dirs[relative] = name
    for index, path in enumerate(sorted(p for p in root.rglob('*') if p.is_file()), 1):
        relative = path.relative_to(root)
        iso.add_file(str(path), iso_path=iso_dirs[relative.parent] + '/F%06d.DAT;1' % index,
                     joliet_path=prefix + '/' + relative.as_posix())
    output = args.output
    if output.exists():
        raise RuntimeError('Refusing to replace existing acceptance ISO')
    iso.write(str(output))
    iso.close()
    print(json.dumps({'path': str(output), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'files': len(manifest) + 1}))


if __name__ == '__main__':
    main()
