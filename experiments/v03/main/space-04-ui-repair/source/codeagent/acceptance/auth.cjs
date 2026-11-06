// Independent JWT contract checks. Kept outside generated code; uses Node built-ins.
const { generateKeyPairSync, sign } = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const project = path.resolve(process.argv[2] || '.');
  const reportPath = path.resolve(process.argv[3] || 'auth-acceptance-report.json');
  const checks = [];
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'acceptance-key', alg: 'RS256', use: 'sig' };
  let issuer;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/.well-known/openid-configuration'
      ? { issuer, jwks_uri: issuer + '/certs' } : { keys: [jwk] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = 'http://127.0.0.1:' + server.address().port;
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const base = { sub: 'acceptance-student', iss: issuer, aud: 'account', iat: now, exp: now + 300 };
  function token(payload, key = privateKey) {
    const data = b64({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }) + '.' + b64(payload);
    return data + '.' + sign('RSA-SHA256', Buffer.from(data), key).toString('base64url');
  }
  let error;
  try {
    const auth = require(path.join(project, 'shared/src/auth.js'));
    auth.configure({ OIDC_ISSUER: issuer, OIDC_AUDIENCE: 'account', OIDC_CLIENT_ID: 'test' });
    for (const [name, value, shouldAccept] of [
      ['valid RSA-signed JWT', token(base), true],
      ['wrong signature rejected', token({ ...base, realm_access: { roles: ['admin'] } }, otherKey), false],
      ['expired token rejected', token({ ...base, exp: now - 300 }), false],
      ['wrong issuer rejected', token({ ...base, iss: 'https://wrong.invalid' }), false],
      ['wrong audience rejected', token({ ...base, aud: 'wrong' }), false],
      ['future not-before rejected', token({ ...base, nbf: now + 300 }), false],
    ]) {
      let accepted = false;
      try { await auth.validateToken(value); accepted = true; } catch { /* expected on invalid tokens */ }
      checks.push({ check: name, status: accepted === shouldAccept ? 'passed' : 'failed', observed: accepted ? 'accepted' : 'rejected' });
    }
  } catch (err) {
    error = err.code || err.name; // never serialize tokens or request headers
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const report = { kind: 'independent_jwt_acceptance', status: error || checks.some(c => c.status === 'failed') ? 'failed' : 'passed', checks, error };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
main().catch(error => { console.error(error.name); process.exitCode = 1; });
