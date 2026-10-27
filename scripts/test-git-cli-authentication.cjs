const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

// Real Git against a local server that always answers 401, so no network or credentials are needed.
const spawnedEnvironments = [];
function loadOperations() {
  const original = Module._load;
  const modulePath = require.resolve('../out/git/gitNativeOperations');
  delete require.cache[modulePath];
  try {
    Module._load = function(name, ...args) {
      if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_key, value) => value === undefined ? undefined : false }) } };
      if (name === 'child_process') {
        const real = require('node:child_process');
        return { ...real, execFile: (file, fileArgs, options, callback) => {
          if (file === 'git') spawnedEnvironments.push({ args: fileArgs.slice(2), env: options.env, timeout: options.timeout });
          return real.execFile(file, fileArgs, options, callback);
        } };
      }
      return original.call(this, name, ...args);
    };
    return require(modulePath);
  } finally { Module._load = original; }
}

async function main() {
  const operations = loadOperations();
  const { describeGitCliFailure, NETWORK_GIT_TIMEOUT_MS } = operations;
  // Pure classification: authentication output on a network command becomes actionable text.
  for (const output of [
    "fatal: could not read Username for 'https://host': terminal prompts disabled",
    "fatal: Authentication failed for 'https://host/r.git/'",
    'git@host: Permission denied (publickey).',
    'Host key verification failed.',
  ]) {
    assert.match(describeGitCliFailure(['fetch', 'origin'], output, false), /需要认证/, output);
  }
  assert.match(describeGitCliFailure(['config', '--local', 'x'], 'could not read Username', false), /^Git CLI 执行失败/, 'local commands keep the raw message');
  assert.match(describeGitCliFailure(['fetch'], 'fatal: unable to access: Could not resolve host', false), /^Git CLI 执行失败/, 'network errors that are not authentication stay raw');
  assert.match(describeGitCliFailure(['push', 'origin'], '', true), /超过 10 分钟/, 'a timeout says the operation was stopped');
  assert.equal(NETWORK_GIT_TIMEOUT_MS, 600000);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-auth-'));
  const server = http.createServer((_req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    // Disable credential helpers for this fixture so the result does not depend on the machine.
    execFileSync('git', ['-C', root, 'config', 'credential.helper', '']);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'http://127.0.0.1:' + server.address().port + '/r.git']);
    const started = Date.now();
    await assert.rejects(operations.fetchRemotes({ fsPath: root }, 'origin'), error => {
      assert.match(error.message, /远程仓库需要认证/, 'the user sees an actionable authentication message');
      assert.match(error.message, /terminal prompts disabled/, 'the original Git output is kept for diagnosis');
      return true;
    });
    assert.ok(Date.now() - started < 30000, 'an authentication failure returns promptly instead of waiting for input');
    const fetchRun = spawnedEnvironments.find(run => run.args[0] === 'fetch');
    assert.equal(fetchRun.env.GIT_TERMINAL_PROMPT, '0', 'network commands disable the terminal prompt');
    assert.equal(fetchRun.timeout, NETWORK_GIT_TIMEOUT_MS, 'network commands carry the upper time bound');
    console.log('Git CLI authentication tests passed: prompt disabled, actionable auth message, raw output kept, timeout bound, non-network commands unchanged.');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
