"""Read-only global ledger accounting. Do not treat an active request as final unknown cost."""
import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.budget import Budget, default_ledger, locked


def report(path):
    budget = Budget(path, None)
    with locked(path.with_suffix('.lock')):
        entries = budget._read()['reservations'].values()
        groups = defaultdict(lambda: {'settled_requests': 0, 'uncertain_requests': 0, 'settled_estimate_cny': 0, 'uncertain_reserved_cny': 0})
        for item in entries:
            prices = item['prices']
            group = groups[(prices['input_per_million'], prices['output_per_million'])]
            if item['state'] == 'settled':
                group['settled_requests'] += 1
                group['settled_estimate_cny'] += item['charged']
            else:
                group['uncertain_requests'] += 1
                group['uncertain_reserved_cny'] += item['charged']
    rows = [{'input_cny_per_million': rates[0], 'output_cny_per_million': rates[1],
             **{k: round(v, 6) if isinstance(v, float) else v for k, v in group.items()}} for rates, group in sorted(groups.items())]
    return {'recorded_utc': datetime.now(timezone.utc).isoformat(), 'scope': 'Entire preserved local ledger, including historical runs, connection tests and development; not a formal-cohort-only cost.',
            'settled_estimate_cny': round(sum(r['settled_estimate_cny'] for r in rows), 6),
            'uncertain_reserved_cny': round(sum(r['uncertain_reserved_cny'] for r in rows), 6),
            'charged_upper_estimate_cny': round(sum(r['settled_estimate_cny'] + r['uncertain_reserved_cny'] for r in rows), 6),
            'requests': sum(r['settled_requests'] + r['uncertain_requests'] for r in rows), 'by_recorded_price': rows,
            'limitations': 'Usage multiplied by confirmed price ceilings, not a provider invoice. Pending requests also appear uncertain; capture final accounting after owned paid calls have ended. No ledger reset.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger', type=Path, default=default_ledger())
    print(json.dumps(report(parser.parse_args().ledger), ensure_ascii=False, indent=2))
