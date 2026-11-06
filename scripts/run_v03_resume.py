"""Audited seed continuation: never overwrites or counts as a fresh generation."""
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


def hashes(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in project_files(root)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--trial', required=True)
    parser.add_argument('--case', choices=('space-fractions', 'library', 'temperature-converter'), required=True)
    parser.add_argument('--seed', required=True, type=Path)
    parser.add_argument('--repair-rounds', type=int, default=3, choices=range(11))
    parser.add_argument('--feedback', type=Path, help='Independent review JSON array; immutable input copied into trial')
    parser.add_argument('--confirm-pricing', action='store_true')
    args = parser.parse_args()
    if not args.confirm_pricing or not args.trial.replace('-', '').replace('_', '').isalnum():
        parser.error('Explicit price confirmation and a new alphanumeric trial ID required')
    seed = args.seed.resolve()
    before = hashes(seed)
    feedback_bytes = args.feedback.read_bytes() if args.feedback else None
    feedback = None
    if feedback_bytes is not None:
        if len(feedback_bytes) > 64000:
            parser.error('Feedback exceeds 64000 bytes')
        feedback = json.loads(feedback_bytes.decode('utf-8'))
        if not isinstance(feedback, list) or any(not isinstance(row, dict) for row in feedback):
            parser.error('Feedback must be an array of check objects')
        for variable in ('DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY'):
            key = user_variable(variable)
            if key and key.encode() in feedback_bytes:
                parser.error('Configured credential detected in feedback; contents withheld')
    source = Path('.') if args.case == 'space-fractions' else Path('benchmarks') / args.case
    frozen = hashes(Path('codeagent'))
    folder = Path('experiments/v03/main') / args.trial
    folder.mkdir(parents=True, exist_ok=False)
    manifest = {'created_utc': datetime.now(timezone.utc).isoformat(), 'generation_origin': 'seed',
                'policy': 'Checkpoint continuation, not a fresh trial; no manual edits to generated source',
                'parent_project': str(seed), 'parent_hashes': before, 'source_hashes': frozen,
                'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                'model': 'deepseek-v4-pro-0813', 'provider': 'bailian',
                'prices': {'input': 12, 'output': 27}, 'max_repair_rounds': args.repair_rounds}
    manifest['runner_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if feedback_bytes is not None:
        manifest['external_feedback'] = {'path': str(args.feedback.resolve()),
                                         'sha256': hashlib.sha256(feedback_bytes).hexdigest()}
        (folder / 'external-feedback-input.json').write_bytes(feedback_bytes)
    (folder / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    receipt = folder / 'receipt.json'
    receipt.write_text('{"status":"running","generation_origin":"seed"}', encoding='utf-8')
    cancel = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: cancel.set())
    def watch():
        while not cancel.wait(1):
            if (folder / 'STOP').exists():
                cancel.set()
    threading.Thread(target=watch, daemon=True).start()
    provider = DeepSeek(user_variable('DASHSCOPE_API_KEY'), Budget(default_ledger(), None, Prices(12, 27)), cancel,
                        pricing_confirmed=True, provider='bailian',
                        base_url=user_variable('DASHSCOPE_BASE_URL') or 'https://ws-hzkcuvkt74i3d6ol.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
                        model='deepseek-v4-pro-0813')
    def emit(event):
        if event.get('event') in ('phase_started', 'task_started', 'runtime_stage', 'run_finished', 'repair_no_progress', 'repair_stagnated'):
            print(json.dumps(event, ensure_ascii=True), flush=True)
    profile = 'generic-node' if args.case == 'temperature-converter' else args.case
    run, report = Agent(provider, cancel, emit, allow_execution=True, acceptance_profile=profile,
                        max_repair_rounds=args.repair_rounds).run(source / 'Architecture_Documentation.md',
                        source / 'Architecture_View.md', Path('runs/v03/main') / args.trial, seed_project=seed,
                        review_feedback=feedback)
    result = {'status': report['status'], 'generation_origin': 'seed', 'run': str(run),
              'turns': report['turns'], 'source_unchanged': frozen == hashes(Path('codeagent')),
              'parent_unchanged': before == hashes(seed), 'project_manually_edited': False,
              'independent_acceptance': 'pending', 'run_estimated_cny': report.get('run_estimated_cny')}
    receipt.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
