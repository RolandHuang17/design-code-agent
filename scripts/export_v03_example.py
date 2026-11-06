"""Export a byte-identical main-tool project only after separate HTTP and browser acceptance."""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.config import user_variable
from codeagent.safety import project_files


def export(trial, run_name, output):
    workspace = Path.cwd().resolve()
    trial, output = trial.resolve(), output.resolve()
    if output.exists() or not output.is_relative_to(workspace / 'examples'):
        raise ValueError('Output must be a NEW directory under workspace examples')
    if Path(run_name).name != run_name or '/' in run_name or '\\' in run_name:
        raise ValueError('Run name must be one directory name')
    independent = json.loads((trial / 'independent-http.json').read_text(encoding='utf-8'))
    browser = json.loads((trial / 'browser.json').read_text(encoding='utf-8'))
    if independent.get('status') != 'passed' or independent.get('source_unchanged') is not True:
        raise ValueError('Independent HTTP acceptance with unchanged source is required')
    if browser.get('status') != 'passed' or browser.get('source_matches_original_run') is not True:
        raise ValueError('Independent browser acceptance with source binding is required')
    run = trial / 'raw' / run_name
    report = json.loads((run / 'artifacts/report.json').read_text(encoding='utf-8'))
    source = run / 'project'
    files = {p.relative_to(source).as_posix(): p for p in project_files(source)}
    expected = {item['path']: item['sha256'] for item in report['files']}
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    if expected != hashes:
        raise ValueError('Archived source does not match the original generated report')
    targets = {output / 'project' / name: path for name, path in files.items()}
    for path in (run / 'inputs').iterdir():
        if path.is_file():
            name = re.sub(r'^[12]-', '', path.name)
            dest = output / 'inputs' / name
            if dest in targets:
                raise ValueError('Duplicate input name')
            targets[dest] = path
    secrets = [user_variable(name).encode() for name in ('DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY') if user_variable(name)]
    for path in targets.values():
        data = path.read_bytes()
        if any(secret in data for secret in secrets) or re.search(rb'\bsk-[A-Za-z0-9]{20,}\b', data):
            raise ValueError('Credential pattern detected; contents not printed')
    manifest = {'trial': trial.relative_to(workspace).as_posix(), 'run_name': run_name, 'project_manually_modified': False,
                'policy': 'Project and input bytes copied without editing. Acceptance applies to this one fresh trial, not a general success rate.',
                'files': {}}
    for target, original in targets.items():
        data = original.read_bytes()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Copy hash mismatch')
        manifest['files'][target.relative_to(output).as_posix()] = digest
    (output / 'EXPORT-MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    import os
    relative = Path(os.path.relpath(trial, output)).as_posix()
    readme = f'''# Temperature converter: fresh generated example

This project was generated from the two [input documents](inputs/) in one fresh main-tool run. Files in [project/](project/) are copied byte-for-byte from the archived output; no generated source was edited manually.

The host generation checks passed. Separate operator acceptance passed {len(independent.get('checks', []))} HTTP checks and {len(browser.get('checks', []))} browser checks. These observations concern this single small Node.js case and do not establish a general success rate or Space Fractions correctness.

- [Frozen input and controller manifest]({relative}/manifest.json)
- [Original run receipt]({relative}/receipt.json)
- [Original generated report]({relative}/raw/{run_name}/artifacts/report.json)
- [Independent HTTP acceptance]({relative}/independent-http.json)
- [Independent browser acceptance]({relative}/browser.json)
- [Archive integrity manifest]({relative}/archive-manifest.json)
- [Export integrity manifest](EXPORT-MANIFEST.json)

Run instructions are in the generated [project README](project/README.md). Node.js is needed to run the generated project; the standalone Agent exe has its own Python runtime.
'''
    (output / 'README.md').write_text(readme, encoding='utf-8')
    return {'output': str(output), 'project_files': len(files), 'project_bytes_unchanged': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--trial', required=True, type=Path)
    parser.add_argument('--run-name', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(export(args.trial, args.run_name, args.output), indent=2))
