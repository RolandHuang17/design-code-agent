"""Independent Windows/WSL local-demo acceptance. Uses only published dev fixtures.

Run from repository root with project and report directory arguments.
Creates independent-other fixture and synchronizes persisted local realm client.
Never use against a production Keycloak instance. Does not store access tokens.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
root = Path(sys.argv[1]).resolve()
report_dir = Path(sys.argv[2]).resolve()
report_dir.mkdir(parents=True, exist_ok=True)
realm = json.loads((root / 'keycloak/realm.json').read_text(encoding='utf-8'))
client = next(c for c in realm['clients'] if c['clientId'] == 'space-fractions-client')
issuer = 'http://localhost:8080/realms/space-fractions'
base = os.environ.get('SPACE_BASE_URL','http://localhost:3000')
if urllib.parse.urlsplit(base).hostname not in ('localhost','127.0.0.1'):
    raise ValueError('This fixture harness only supports a loopback gateway')

def http(url, method='GET', body=None, token=None, form=False):
    headers = {'Content-Type': 'application/x-www-form-urlencoded' if form else 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = (urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()) if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with opener.open(req, timeout=20) as res:
            raw = res.read()
            return res.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        return exc.code, {}

def login(name):
    fields = {'grant_type':'password', 'client_id':client['clientId'], 'username':name, 'password':name, 'scope':'openid'}
    if not client.get('publicClient'):
        fields['client_secret'] = client['secret']
    status, data = http(issuer+'/protocol/openid-connect/token','POST',fields,form=True)
    if status != 200:
        raise RuntimeError(f'Fixture login {name}: HTTP {status}')
    return data['access_token']

# Create a third ordinary fixture identity through the local Keycloak admin API.
status, master = http('http://localhost:8080/realms/master/protocol/openid-connect/token','POST',
                      {'grant_type':'password','client_id':'admin-cli','username':'admin','password':'admin'},form=True)
if status != 200:
    raise RuntimeError('Local fixture administrator login failed')
admin_token = master['access_token']
users_url = 'http://localhost:8080/admin/realms/space-fractions/users'
_, fixture_admins = http(users_url+'?username=admin&exact=true',token=admin_token)
setup = []
clients_url = 'http://localhost:8080/admin/realms/space-fractions/clients'
_, fixture_clients = http(clients_url+'?clientId=space-fractions-client',token=admin_token)
for fixture_client in fixture_clients:
    changed = any(fixture_client.get(k) != client.get(k) for k in ('publicClient','attributes','redirectUris','webOrigins'))
    if changed:
        for k in ('publicClient','attributes','redirectUris','webOrigins'):
            fixture_client[k] = client.get(k)
        code, _ = http(clients_url+'/'+fixture_client['id'],'PUT',fixture_client,admin_token)
        setup.append({'action':'synchronize local fixture client with repository realm after persisted-volume update','status':code})
for fixture_admin in fixture_admins:
    if not fixture_admin.get('lastName'):
        fixture_admin['lastName'] = 'Fixture'
        code, _ = http(users_url+'/'+fixture_admin['id'],'PUT',fixture_admin,admin_token)
        setup.append({'action':'supply missing admin fixture lastName for Keycloak required profile','status':code})
(report_dir/'operator-fixture-setup.json').write_text(json.dumps(setup,indent=2),encoding='utf-8')
status, _ = http(users_url,'POST',{'username':'independent-other','enabled':True,'emailVerified':True,
                                 'firstName':'Independent','lastName':'Other','email':'other@example.invalid',
                                 'credentials':[{'type':'password','value':'independent-other','temporary':False}]},admin_token)
if status not in (201,409):
    raise RuntimeError('Cannot create local test identity')
tokens = {'user':login('student'),'admin':login('admin'),'other':login('independent-other')}
env = {**{k:v for k,v in os.environ.items() if not k.upper().endswith('API_KEY') and k.upper() not in ('NODE_OPTIONS','PYTHONPATH')}, **{k:v for k,v in zip(('SPACE_USER_TOKEN','SPACE_ADMIN_TOKEN','SPACE_OTHER_USER_TOKEN'),tokens.values())}}
result = subprocess.run([sys.executable,'scripts/evaluate_project.py','--base-url',base,'--report',str(report_dir/'independent-http.json')],env=env)

def api(path, method='GET', body=None):
    return http(base+path,method,body,tokens['user'])

checks = []
status, readiness = http(base+'/health/ready')
checks.append({'check':'gateway downstream readiness','status':'passed' if status==200 else 'failed','http_status':status})
status, question = http(base+'/api/admin/questions','POST',{'prompt':'UniqueNebulaAcceptance 1/2 + 1/4?', 'options':['3/4','1/2'], 'correctAnswer':'3/4'},tokens['admin'])
if status==201:
    import time
    # ES uses asynchronous indexing and normal periodic refresh.
    found = []
    for _ in range(15):
        _, answer = http(base+'/api/questions/search?q=UniqueNebulaAcceptance')
        found = answer.get('questions',[])
        if any(str(q.get('id'))==str(question['id']) for q in found): break
        time.sleep(1)
    es_status, es = http('http://localhost:9200/questions/_doc/'+str(question['id']))
    checks.append({'check':'question indexed and found through actual Elasticsearch','status':'passed' if any(str(q.get('id'))==str(question['id']) for q in found) and es_status==200 and es.get('found') is True else 'failed','elasticsearch_status':es_status})
    http(base+'/api/admin/questions/'+str(question['id']),'DELETE',token=tokens['admin'])
else:
    checks.append({'check':'search fixture creation','status':'failed','http_status':status})
status, targets = http('http://localhost:9090/api/v1/targets')
active = targets.get('data',{}).get('activeTargets',[])
checks.append({'check':'Prometheus scrapes five service metrics endpoints','status':'passed' if status==200 and len(active)>=5 and all(t.get('health')=='up' for t in active) else 'failed','targets':len(active)})
status, game = api('/api/games','POST',{})
checks.append({'check':'concurrent game creation','status':'passed' if status==201 else 'failed','http_status':status})
if status==201 and game.get('questions'):
    q = game['questions'][0]
    status, private = http(base+'/api/admin/questions/'+str(q['id']),token=tokens['admin'])
    answer = private.get('correctAnswer',private.get('correct_answer'))
    endpoint = '/api/games/'+str(game['id'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        outputs = list(pool.map(lambda _:api(endpoint+'/answers','POST',{'questionId':q['id'],'answer':answer}),range(8)))
    status, score = api(endpoint+'/score')
    checks.append({'check':'8 concurrent duplicate answers score once','status':'passed' if status==200 and score.get('score')==1 and all(s in (200,409) for s,_ in outputs) else 'failed',
                   'response_statuses':[s for s,_ in outputs],'score':score.get('score')})
    # Restart only our generated services; keep storage volumes intact.
    compose = '/mnt/d/projects/Task/'+root.relative_to(Path.cwd()).as_posix()+'/compose.yaml'
    restart = subprocess.run(['wsl','-d','Ubuntu','-u','root','--','env','GATEWAY_PORT=3100','docker','compose','-p',os.environ.get('SPACE_COMPOSE_PROJECT','space-fractions'),'-f',compose,'restart','game-service','user-service'],capture_output=True)
    (report_dir/'restart-command.txt').write_text(restart.stdout.decode(errors='replace')+restart.stderr.decode(errors='replace'),encoding='utf-8')
    import time
    restored = None
    for _ in range(40):
        try:
            st, restored = api(endpoint+'/score')
            if st==200:
                break
        except OSError:
            pass
        time.sleep(1)
    checks.append({'check':'score survives service restart','status':'passed' if restart.returncode==0 and restored and restored.get('score')==1 else 'failed'})
    api(endpoint)  # GET game populates the cache; score-only GET deliberately does not.
    redis = subprocess.run(['wsl','-d','Ubuntu','-u','root','--','docker','exec',os.environ.get('SPACE_COMPOSE_PROJECT','space-fractions')+'-redis-1','redis-cli','get','game:'+str(game['id'])],capture_output=True)
    cached = json.loads(redis.stdout.decode().strip() or '{}')
    checks.append({'check':'actual Redis game cache contains latest persisted score','status':'passed' if cached.get('score')==1 else 'failed'})
    mq = subprocess.run(['node',str(Path(__file__).with_name('check_mq.cjs')),str(root)],env={**env,'SPACE_BASE_URL':base},capture_output=True)
    mq_report = json.loads(mq.stdout.decode())
    (report_dir/'independent-rabbitmq.json').write_text(json.dumps(mq_report,indent=2),encoding='utf-8')
    checks.append({'check':'real score event delivered through RabbitMQ','status':mq_report['status']})
(report_dir/'independent-concurrency-persistence.json').write_text(json.dumps({'checks':checks},indent=2),encoding='utf-8')
print(json.dumps(checks,indent=2))
raise SystemExit(result.returncode or int(any(c['status']!='passed' for c in checks)))
