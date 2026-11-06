"""One fresh paid main-tool trial, frozen before invocation; no silent retries or seed reuse."""
import argparse
import hashlib
import json
import signal
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.budget import Budget, Prices, default_ledger
from codeagent.config import user_variable
from codeagent.engine import Agent
from codeagent.provider import DeepSeek
from codeagent.safety import project_files


def fingerprints(paths):
    files = []
    for path in paths:
        files.extend(project_files(path) if path.is_dir() else [path])
    return {p.as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(files))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--trial', required=True)
    parser.add_argument('--case', choices=('space-fractions', 'library', 'temperature-converter'), required=True)
    parser.add_argument('--repair-rounds', type=int, default=3)
    parser.add_argument('--input-price', type=float, required=True)
    parser.add_argument('--output-price', type=float, required=True)
    parser.add_argument('--confirm-pricing', action='store_true')
    args = parser.parse_args()
    if not args.confirm_pricing or not 0 <= args.repair_rounds <= 10 or not args.trial.replace('-', '').replace('_', '').isalnum():
        parser.error('Confirm prices, use 0–10 repair rounds and an alphanumeric trial identifier')
    source = Path('.') if args.case == 'space-fractions' else Path('benchmarks') / args.case
    inputs = [source / 'Architecture_Documentation.md', source / 'Architecture_View.md']
    # The external checker is frozen as operator evidence, never supplied to Agent.
    frozen = [Path('codeagent'), *inputs, Path(__file__).relative_to(Path.cwd()), Path('scripts/check_temperature.py')]
    folder = Path('experiments/v03/main') / args.trial
    folder.mkdir(parents=True, exist_ok=False)
    hashes = fingerprints(frozen)
    profile = 'generic-node' if args.case == 'temperature-converter' else args.case
    manifest = {'created_utc': datetime.now(timezone.utc).isoformat(), 'program': 'main', 'case': args.case,
                'provider': 'bailian', 'model': 'deepseek-v4-pro-0813', 'input_price': args.input_price,
                'output_price': args.output_price, 'max_repair_rounds': args.repair_rounds,
                'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                'source_hashes': hashes, 'policy': 'Fresh run, no seed or manual project edits. Independent checker not supplied to model.'}
    (folder / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    receipt = folder / 'receipt.json'
    receipt.write_text(json.dumps({'status': 'running', 'note': 'An interrupted receipt remains interrupted; never silently restart this trial.'}), encoding='utf-8')
    cancel = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: cancel.set())
    stop = folder / 'STOP'
    def watch():
        while not cancel.wait(1):
            if stop.exists():
                cancel.set()
    threading.Thread(target=watch, daemon=True).start()
    provider = DeepSeek(user_variable('DASHSCOPE_API_KEY'), Budget(default_ledger(), None, Prices(args.input_price, args.output_price)), cancel,
                        pricing_confirmed=True, provider='bailian', base_url=user_variable('DASHSCOPE_BASE_URL') or 'https://dashscope.aliyuncs.com/compatible-mode/v1', model='deepseek-v4-pro-0813')
    def emit(event):
        if event.get('event') in ('phase_started', 'task_started', 'runtime_stage', 'run_finished', 'repair_no_progress'):
            print(json.dumps(event, ensure_ascii=True), flush=True)
    agent = Agent(provider, cancel, emit, allow_execution=True, acceptance_profile=profile, max_repair_rounds=args.repair_rounds)
    run, report = agent.run(*inputs, Path('runs/v03/main') / args.trial)
    result = {'status': report['status'], 'run': str(run), 'turns': report['turns'],
              'source_unchanged': hashes == fingerprints(frozen), 'project_manually_edited': False,
              'independent_acceptance': 'pending', 'run_estimated_cny': report.get('run_estimated_cny')}
    receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True))
    if not result['source_unchanged']:
        raise RuntimeError('Frozen source changed during trial; preserve as non-frozen evidence')


if __name__ == '__main__':
    main()
