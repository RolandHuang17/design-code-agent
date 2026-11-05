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
    args=parser.parse_args()
    cancel=threading.Event()
    signal.signal(signal.SIGINT,lambda *_:cancel.set())
    session=ComposeSession(args.project,args.artifacts,cancel,Redactor())
    try:
        session.start()
        result=exercise(session,args.profile)
        (args.artifacts/'browser-preflight.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        if result['status']!='passed':
            raise RuntimeError(result.get('error','Independent preflight failed'))
        print(json.dumps({'base_url':session.base,'identity_url':f'http://localhost:{session.oidc_port}','project':session.project}),flush=True)
        while not cancel.wait(1):pass
    finally:
        session.close()


if __name__=='__main__':main()
