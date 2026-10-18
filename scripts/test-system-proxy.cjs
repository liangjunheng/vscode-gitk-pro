const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;

function loadOperations({ useSystemProxy, vscodeProxy = '' }) {
    const calls = [];
    const modulePath = require.resolve('../out/git/gitNativeOperations');
    delete require.cache[modulePath];
    try {
        Module._load = function(request, parent, isMain) {
            if (request === 'vscode') return {
                Uri: { file: fsPath => ({ fsPath }) },
                workspace: {
                    getConfiguration: section => ({
                        get: (key, defaultValue) => {
                            if (section === 'vscode-gitk' && key === 'useSystemProxy') return useSystemProxy;
                            if (section === 'http' && key === 'proxy') return vscodeProxy;
                            return defaultValue;
                        },
                    }),
                },
            };
            if (request === './nativeGitBinding') return { invokeNativeGit: async () => { throw new Error('Unexpected native call'); } };
            if (request === 'child_process') return {
                execFile: (file, args, options, callback) => {
                    calls.push({ file, args, options });
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
    assert.equal(git.options.env.HTTP_PROXY, 'http://proxy-http:8080');
    assert.equal(git.options.env.HTTPS_PROXY, 'http://proxy-https:8443');
    assert.equal(git.options.env.NO_PROXY, '*.corp,localhost,127.0.0.1,::1');
}

async function testVscodeProxyTakesPrecedence() {
    const { operations, calls } = loadOperations({ useSystemProxy: true, vscodeProxy: 'vscode-proxy:9000' });
    await operations.fetchRemotes({ fsPath: 'C:/repo' }, 'origin');
    assert.equal(calls.filter(call => call.file === 'reg').length, 0, 'VS Code proxy avoids a system-registry lookup');
    const git = calls.find(call => call.file === 'git' && call.args.includes('fetch'));
    assert.equal(git.options.env.HTTP_PROXY, 'http://vscode-proxy:9000');
    assert.equal(git.options.env.HTTPS_PROXY, 'http://vscode-proxy:9000');
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
    await testVscodeProxyTakesPrecedence();
    await testDisabledSystemProxy();
    console.log('System proxy tests passed: Windows proxy, VS Code override, bypass list, and opt-out.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
