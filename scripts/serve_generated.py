"""Serve a generated example through the same isolated deployment adapter for browser review."""
import argparse
import json
import signal
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.acceptance.http_checks import exercise
from codeagent.runtime import ComposeSession
from codeagent.safety import Redactor


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('project',type=Path)
    parser.add_argument('--profile',choices=('space-fractions','library'),required=True)
    parser.add_argument('--artifacts',type=Path,required=True)
    parser.add_argument('--stop-file',type=Path,help='Cooperative stop marker; cleanup runs in finally')
    parser.add_argument('--demo-only',action='store_true',help='Serve for recording without rerunning acceptance; explicitly marked unverified')
    args=parser.parse_args()
    cancel=threading.Event()
    signal.signal(signal.SIGINT,lambda *_:cancel.set())
    session=ComposeSession(args.project,args.artifacts,cancel,Redactor())
    try:
        session.start()
        result=({'status':'unverified','reason':'Demo-only server; acceptance preflight deliberately not run'}
                if args.demo_only else exercise(session,args.profile))
        (args.artifacts/'browser-preflight.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        if result['status']!='passed' and not args.demo_only:
            raise RuntimeError(result.get('error','Independent preflight failed'))
        print(json.dumps({'base_url':session.base,'identity_url':f'http://localhost:{session.oidc_port}','project':session.project}),flush=True)
        while not cancel.wait(1):
            if args.stop_file and args.stop_file.exists():
                cancel.set()
    finally:
        session.close()


if __name__=='__main__':main()
