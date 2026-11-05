"""Sequential frozen-cohort experiment runner. No generated project edits or seed reuse."""
import argparse
import hashlib
import json
import signal
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

# Permit direct `python scripts/run_benchmark.py` from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.budget import Budget, Prices, default_ledger
from codeagent.config import user_variable
from codeagent.engine import Agent
from codeagent.provider import DeepSeek
from codeagent.safety import project_files


def fingerprint():
    roots = [Path('codeagent'), Path('benchmarks/library')]
    paths = [p for root in roots for p in project_files(root) if p.suffix in ('.py', '.md', '.cjs')]
    paths += [Path('Architecture_Documentation.md'), Path('Architecture_View.md'), Path(__file__).relative_to(Path.cwd())]
    return {p.as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def main():
    parser = argparse.ArgumentParser(description='Frozen v0.2 cohort; records every trial, does not cherry-pick')
    parser.add_argument('--cohort', required=True)
    parser.add_argument('--confirm-pricing', action='store_true')
    args = parser.parse_args()
    if not args.cohort.replace('-', '').replace('_', '').isalnum():
        parser.error('cohort must contain letters/numbers/hyphen/underscore')
    if not args.confirm_pricing:
        parser.error('Explicit --confirm-pricing required before paid experiments (9/27 CNY per million)')
    folder = Path('experiments/v02') / args.cohort
    folder.mkdir(parents=True, exist_ok=True)
    manifest_path = folder / 'manifest.json'
    jobs = [{'case': 'space-fractions', 'repair_rounds': 3, 'repeat': n} for n in range(1, 4)]
    jobs += [{'case': 'library', 'repair_rounds': rounds, 'repeat': n} for rounds in (0, 3) for n in range(1, 4)]
    hashes = fingerprint()
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if manifest['source_hashes'] != hashes:
            raise RuntimeError('Frozen controller/input changed; preserve this cohort and create a new named cohort')
    else:
        manifest = {'created_utc': datetime.now(timezone.utc).isoformat(), 'model':'deepseek-v4-pro-0813',
                    'provider':'bailian', 'base_url':user_variable('DASHSCOPE_BASE_URL'), 'prices':{'input':9,'output':27}, 'max_turns':300,
                    'git_commit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
                    'source_hashes':hashes,'jobs':jobs,'policy':'All trials from empty directory; no manual generated-code edits; no seed. Small sample, no significance claim.'}
        manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    results_path = folder / 'results.json'
    results = json.loads(results_path.read_text(encoding='utf-8')) if results_path.exists() else []
    if any(r.get('status') == 'running' for r in results):
        raise RuntimeError('An interrupted trial remains running; classify it explicitly before resuming, never silently rerun it')
    cancel = threading.Event()
    signal.signal(signal.SIGINT, lambda *_:cancel.set())
    for index, job in enumerate(jobs[len(results):], start=len(results)+1):
        if cancel.is_set(): break
        if fingerprint() != hashes: raise RuntimeError('Frozen source changed before trial')
        row = {'trial':index, **job, 'status':'running'}
        results.append(row)
        results_path.write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        provider = DeepSeek(user_variable('DASHSCOPE_API_KEY'),Budget(default_ledger(),None,Prices(9,27)),cancel,
                            pricing_confirmed=True,provider='bailian',base_url=manifest['base_url'],model='deepseek-v4-pro-0813')
        def emit(event):
            kind = event['event']
            if kind in ('phase_started','task_started','runtime_stage','run_finished','repair_no_progress'):
                print(json.dumps({'trial':index,**event},ensure_ascii=True),flush=True)
            elif kind=='tool_result':
                print(json.dumps({'trial':index,'tool':event['tool'],'result':{k:v for k,v in event['result'].items() if k in ('written','error','profile','status')}},ensure_ascii=True),flush=True)
        source = Path('.') if job['case']=='space-fractions' else Path('benchmarks/library')
        agent = Agent(provider,cancel,emit,allow_execution=True,acceptance_profile=job['case'],max_repair_rounds=job['repair_rounds'])
        run, report = agent.run(source/'Architecture_Documentation.md',source/'Architecture_View.md',Path('runs/v02-formal')/args.cohort)
        row.update(status=report['status'],run=str(run),turns=report['turns'],elapsed_seconds=report['elapsed_seconds'],
                   run_estimated_cny=report['run_estimated_cny'],tool_metrics=report['tool_metrics'],
                   checks=[{'profile':c.get('profile'),'status':c.get('status')} for c in report['checks']])
        row['source_unchanged'] = fingerprint()==hashes
        results_path.write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        if not row['source_unchanged']: raise RuntimeError('Source changed during trial; cohort is not a frozen comparison')
        if cancel.is_set(): break


if __name__=='__main__':
    main()
