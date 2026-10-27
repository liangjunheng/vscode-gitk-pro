const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;

function loadOperations({ useSystemProxy, vscodeProxy = '', fetchFailures = 0, nativeProxyCheck }) {
    const calls = [];
    let remainingFetchFailures = fetchFailures;
    const modulePath = require.resolve('../out/git/gitNativeOperations');
    delete require.cache[modulePath];
    try {
        Module._load = function(request, parent, isMain) {
            if (request === 'vscode') return {
                Uri: { file: fsPath => ({ fsPath }) },
                workspace: {
                    getConfiguration: section => ({
                        get: (key, defaultValue) => {
                            if (section === 'fastergit' && key === 'useSystemProxy') return useSystemProxy;
                            if (section === 'http' && key === 'proxy') return vscodeProxy;
                            return defaultValue;
                        },
                    }),
                },
            };
            if (request === './nativeGitBinding') return {
                invokeNativeGit: async () => { throw new Error('Unexpected native call'); },
                invokeNativeGitPriorityRead: async operation => {
                    if (operation !== 'explicitProxyConfigured') throw new Error('Unexpected native call: ' + operation);
                    // Default: an older binary without the operation, so the Git CLI config check runs.
                    if (nativeProxyCheck === undefined) throw new Error('不支持的 libgit2 操作: ' + operation);
                    return nativeProxyCheck;
                },
            };
            if (request === 'child_process') return {
                execFile: (file, args, options, callback) => {
                    calls.push({ file, args, options });
                    if (file === 'git' && args.includes('fetch') && remainingFetchFailures > 0) {
                        remainingFetchFailures--;
                        callback(new Error('simulated fetch failure'), '', 'simulated fetch failure');
                        return;
                    }
                    if (file === 'reg') {
                        const name = args.at(-1);
                        const values = {
                            ProxyEnable: 'ProxyEnable    REG_DWORD    0x1\r\n',
                            ProxyServer: 'ProxyServer    REG_SZ    http=proxy-http:8080;https=proxy-https:8443\r\n',
                            ProxyOverride: 'ProxyOverride    REG_SZ    *.corp;<local>\r\n',

                            AutoConfigURL: '',
                            AutoDetect: 'AutoDetect    REG_DWORD    0x0\\r\\n',
                        };
                        callback(null, values[name], '');
                        return;
                    }
                    callback(null, '', '');
                },
            };
            return originalLoad.call(this, request, parent, isMain);
        };
        return { operations: require(modulePath), calls };
    } finally {
        Module._load = originalLoad;
    }
}

async function testWindowsSystemProxy() {
    const { operations, calls } = loadOperations({ useSystemProxy: true });
    await operations.fetchRemotes({ fsPath: 'C:/repo' }, 'origin');
    const git = calls.find(call => call.file === 'git' && call.args.includes('fetch'));
    assert.ok(git, 'fetch starts Git CLI');
    assert.deepEqual(git.args, ['-C', 'C:/repo', 'fetch', '--prune', '--no-recurse-submodules', 'origin'],
        'Fetch leaves recursive submodule scheduling to the extension');
    assert.equal(git.options.env.HTTP_PROXY, 'http://proxy-http:8080');
    assert.equal(git.options.env.HTTPS_PROXY, 'http://proxy-https:8443');
    assert.equal(git.options.env.NO_PROXY, '*.corp,localhost,127.0.0.1,::1');
}

async function testConcurrentFetchWaveSharesSystemProxyLookup() {
    const { operations, calls } = loadOperations({ useSystemProxy: true });
    await Promise.all(Array.from({ length: 6 }, (_value, index) =>
        operations.fetchRemotes({ fsPath: `C:/repo-${index}` })));
    assert.equal(calls.filter(call => call.file === 'reg').length, 5,
        'a parallel repository wave reads the five Windows proxy values once, not once per repository');
    assert.equal(calls.filter(call => call.file === 'git' && call.args.includes('config')).length, 6,
        'repository-specific Git proxy configuration is still checked independently');
    const fetchCalls = calls.filter(call => call.file === 'git' && call.args.includes('fetch'));
    assert.equal(fetchCalls.length, 6,
        'distinct repositories still start independent fetch commands');
    assert.deepEqual(fetchCalls.map(call => call.args.slice(2)), Array.from({ length: 6 }, () =>
        ['fetch', '--all', '--prune', '--no-recurse-submodules']),
        'every full Fetch leaves recursive submodule scheduling to the extension');
    assert.equal(calls.length, 17, 'six repositories use 17 child processes instead of the previous 42');
}

async function testOverlappingFetchSharesGitCommand() {
    const { operations, calls } = loadOperations({ useSystemProxy: true });
    const first = operations.fetchRemotes({ fsPath: 'C:/same-repo' });
    const overlapping = operations.fetchRemotes({ fsPath: 'C:/same-repo/' });
    assert.equal(overlapping, first, 'background and manual fetch share the same in-flight promise');
    await first;
    assert.equal(calls.filter(call => call.file === 'git' && call.args.includes('fetch')).length, 1,
        'overlapping callers launch one real fetch command');
    assert.equal(calls.length, 7, 'overlapping callers use one config check, one proxy lookup wave, and one fetch');

    const later = operations.fetchRemotes({ fsPath: 'C:/same-repo' });
    assert.notEqual(later, first, 'a later explicit fetch starts again after the shared task completes');
    await later;
    assert.equal(calls.filter(call => call.file === 'git' && call.args.includes('fetch')).length, 2);
}

async function testDifferentRemotesDoNotShareFetch() {
    const { operations, calls } = loadOperations({ useSystemProxy: true });
    const origin = operations.fetchRemotes({ fsPath: 'C:/same-repo' }, 'origin');
    const upstream = operations.fetchRemotes({ fsPath: 'C:/same-repo' }, 'upstream');
    assert.notEqual(upstream, origin, 'different remote selections keep independent fetch commands');
    await Promise.all([origin, upstream]);
    assert.equal(calls.filter(call => call.file === 'git' && call.args.includes('fetch')).length, 2);
}

async function testFailedFetchReleasesSingleFlight() {
    const { operations, calls } = loadOperations({ useSystemProxy: true, fetchFailures: 1 });
    const failed = operations.fetchRemotes({ fsPath: 'C:/retry-repo' });
    const overlapping = operations.fetchRemotes({ fsPath: 'C:/retry-repo/' });
    assert.equal(overlapping, failed, 'overlapping callers share the same failure');
    await assert.rejects(failed, /simulated fetch failure/);
    const retry = operations.fetchRemotes({ fsPath: 'C:/retry-repo' });
    assert.notEqual(retry, failed, 'a failed shared fetch releases its key for retry');
    await retry;
    assert.equal(calls.filter(call => call.file === 'git' && call.args.includes('fetch')).length, 2,
        'the retry starts exactly one new fetch command');
}
async function testVscodeProxyTakesPrecedence() {
    const { operations, calls } = loadOperations({ useSystemProxy: true, vscodeProxy: 'vscode-proxy:9000' });
    await operations.fetchRemotes({ fsPath: 'C:/repo' }, 'origin');
    assert.equal(calls.filter(call => call.file === 'reg').length, 0, 'VS Code proxy avoids a system-registry lookup');
    const git = calls.find(call => call.file === 'git' && call.args.includes('fetch'));
    assert.equal(git.options.env.HTTP_PROXY, 'http://vscode-proxy:9000');
    assert.equal(git.options.env.HTTPS_PROXY, 'http://vscode-proxy:9000');
}

async function testNativeProxyCheckSkipsGitConfig() {
    const { operations, calls } = loadOperations({ useSystemProxy: true, nativeProxyCheck: false });
    await Promise.all(Array.from({ length: 6 }, (_value, index) => operations.fetchRemotes({ fsPath: `C:/native-${index}` })));
    assert.equal(calls.filter(call => call.file === 'git' && call.args.includes('config')).length, 0,
        'the native explicit-proxy check replaces one git config process per repository');
    assert.equal(calls.filter(call => call.file === 'git' && call.args.includes('fetch')).length, 6);
    assert.equal(calls.length, 11, 'six repositories need 5 registry reads and 6 fetches, down from 17 processes');
    const git = calls.find(call => call.file === 'git' && call.args.includes('fetch'));
    assert.equal(git.options.env.HTTP_PROXY, 'http://proxy-http:8080', 'system proxy still applies without explicit Git proxy');

    const explicit = loadOperations({ useSystemProxy: true, nativeProxyCheck: true });
    await explicit.operations.fetchRemotes({ fsPath: 'C:/explicit' }, 'origin');
    assert.equal(explicit.calls.filter(call => call.file === 'reg').length, 0, 'an explicit Git proxy skips the system lookup');
    const explicitFetch = explicit.calls.find(call => call.file === 'git' && call.args.includes('fetch'));
    assert.equal(explicitFetch.options.env.HTTP_PROXY, process.env.HTTP_PROXY, 'explicit Git proxy keeps the inherited environment');
}

async function testDisabledSystemProxy() {
    const { operations, calls } = loadOperations({ useSystemProxy: false });
    await operations.fetchRemotes({ fsPath: 'C:/repo' }, 'origin');
    assert.equal(calls.filter(call => call.file === 'reg').length, 0, 'disabled setting does not read the system proxy');
    const git = calls.find(call => call.file === 'git' && call.args.includes('fetch'));
    assert.equal(git.options.env.HTTP_PROXY, process.env.HTTP_PROXY);
    assert.equal(git.options.env.HTTPS_PROXY, process.env.HTTPS_PROXY);
}

(async () => {
    await testWindowsSystemProxy();
    await testConcurrentFetchWaveSharesSystemProxyLookup();
    await testOverlappingFetchSharesGitCommand();
    await testDifferentRemotesDoNotShareFetch();
    await testNativeProxyCheckSkipsGitConfig();
    await testFailedFetchReleasesSingleFlight();
    await testVscodeProxyTakesPrecedence();
    await testDisabledSystemProxy();
    console.log('Fetch coordination/system proxy tests passed: shared fetch, path normalization, remote isolation, failure retry, one proxy lookup per wave, VS Code override, bypass list, and opt-out.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
