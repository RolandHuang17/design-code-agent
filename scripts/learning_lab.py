"""Free scripted mechanism exercises; no API calls and no claim of model-generated success."""
import argparse
import json
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from codeagent.inputs import load_inputs
from codeagent.safety import Redactor
from codeagent.tools import Toolset


def exercise(name):
    if name == 'inputs':
        result = load_inputs(Path('Architecture_Documentation.md'), Path('Architecture_View.md'))
        return {'mode': 'offline mechanism exercise', 'diagram_count': result['diagram_count'], 'issues': result['issues'],
                'documents': [{k: d[k] for k in ('filename', 'sha256', 'line_count')} for d in result['documents']]}
    with tempfile.TemporaryDirectory(prefix='dca-learning-') as temporary:
        root = Path(temporary) / 'project'
        root.mkdir()
        tools = Toolset(root, threading.Event(), Redactor(), allow_execution=name == 'repair')
        results = []
        def call(tool, **args):
            result = tools.execute(tool, json.dumps(args))
            results.append({'tool': tool, 'arguments': args, 'result': result})
            return result
        if name == 'tools':
            assert 'error' in call('write_file', path='../outside.txt', content='blocked')
            assert not (root.parent / 'outside.txt').exists()
            call('write_file', path='src/math.js', content='module.exports = 1;')
            tools = Toolset(root, threading.Event(), Redactor())  # Fresh tool context has not observed this file.
            assert 'error' in call('write_file', path='src/math.js', content='module.exports = 2;')
            call('read_file', path='src/math.js')
            assert 'written' in call('edit_file', path='src/math.js', old='1', new='2')
        else:
            call('write_file', path='src/math.js', content='function broken( {')
            before = call('run_check', profile='static')
            call('read_file', path='src/math.js')
            call('edit_file', path='src/math.js', old='function broken( {', new='module.exports = (a, b) => a + b;')
            after = call('run_check', profile='static')
            # Required repository files are deliberately absent. Inspect the actual syntax item.
            syntax = lambda check: next(c for c in check['results'] if c['check'] == 'src/math.js')
            if syntax(after)['status'] != 'unverified':
                assert syntax(before)['status'] == 'failed' and syntax(after)['status'] == 'passed'
        return {'mode': 'offline scripted mechanism exercise; not an LLM experiment', 'steps': results}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('exercise', choices=('inputs', 'tools', 'repair'))
    print(json.dumps(exercise(parser.parse_args().exercise), ensure_ascii=False, indent=2))
