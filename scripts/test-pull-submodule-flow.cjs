const nodeAssert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;

function loadFresh(modulePath, mocks) {
    delete require.cache[require.resolve(modulePath)];
    try {
        Module._load = function(request, parent, isMain) {
            if (Object.prototype.hasOwnProperty.call(mocks, request)) {
                return mocks[request];
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

async function testFetchesRootAndSubmodulesInParallel() {
    const rootPath = 'C:\\fixture';
    const childPath = 'C:\\fixture\\child';
    const siblingPath = 'C:\\fixture\\sibling';
    const nestedPath = 'C:\\fixture\\child\\nested';
    const submodulesByRepository = new Map([
        [rootPath, [childPath, siblingPath]],
        [childPath, [nestedPath]],
        [siblingPath, []],
        [nestedPath, []],
    ]);
    const progress = [];
    const fetchStarts = [];
    const fetchResolvers = [];
    const invokeNativeGit = async (operation, payload) => {
        if (operation === 'submodules') {
            return (submodulesByRepository.get(payload.rootPath) ?? []).map(absolutePath => ({ absolutePath }));
        }
        if (operation === 'discover') return { workdir: payload.path };
        if (operation === 'branches') return { local: [], remote: [] };
        throw new Error(`Unexpected native operation: ${operation}`);
    };
    const provider = loadFresh('../out/git/gitLogProvider', {
        vscode: { Uri: { file: fsPath => ({ fsPath, toString: () => fsPath }) } },
        './nativeGitBinding': { invokeNativeGit },
        './gitNativeOperations': {
            fetchRemotes: async (rootUri, remote) => {
                fetchStarts.push([rootUri.fsPath, remote]);
                await new Promise(resolve => fetchResolvers.push(resolve));
            },
            pull: async () => {},
            push: async () => ({}),
            updateSubmodules: async () => {},
        },
    });
    const rootUri = { fsPath: rootPath, toString: () => rootPath };
    const pending = provider.runGitSync(rootUri, 'fetch', message => progress.push(message), undefined, { fetch: ['origin'], pull: ['origin'] });
    await new Promise(resolve => setImmediate(resolve));
    nodeAssert.deepEqual(fetchStarts, [
        [rootPath, 'origin'],
        [childPath, undefined],
        [siblingPath, undefined],
        [nestedPath, undefined],
    ], 'the selected repository fetches the Remote selector value while discovered submodules keep their own remote scope');
    nodeAssert.equal(fetchResolvers.length, 4, 'all repository fetches are in flight together');
    fetchResolvers.splice(0).forEach(resolve => resolve());
    const result = await pending;
    nodeAssert.equal(result.summary, '获取完成：远程分支无变化，已获取 3 个子模块');
    nodeAssert.ok(progress[0].includes('正在并行获取 4 个仓库（含 3 个子模块）'));
    nodeAssert.equal(progress.filter(message => message.startsWith('仓库获取完成（')).length, 4);
}

async function testPullChecksStaleSubmodulesWithoutHeadChange() {
    const progress = [];
    const updateCalls = [];
    const pullRemotes = [];
    const head = 'a'.repeat(40);
    const invokeNativeGit = async operation => {
        if (operation === 'head') return { hash: head };
        if (operation === 'branches') return { local: [], remote: [] };
        if (operation === 'submodules') return [
            { path: 'modules/current', indexId: '1'.repeat(40), workdirId: '1'.repeat(40) },
            { path: 'modules/stale', indexId: '2'.repeat(40), workdirId: '1'.repeat(40) },
            { path: 'modules/missing', indexId: '3'.repeat(40), workdirId: null },
        ];
        throw new Error(`Unexpected native operation: ${operation}`);
    };
    const provider = loadFresh('../out/git/gitLogProvider', {
        vscode: { Uri: { file: fsPath => ({ fsPath, toString: () => fsPath }) } },
        './nativeGitBinding': { invokeNativeGit },
        './gitNativeOperations': {
            fetchRemotes: async () => {},
            pull: async (_rootUri, remote) => { pullRemotes.push(remote); },
            push: async () => ({}),
            updateSubmodules: async (_rootUri, paths) => updateCalls.push([...paths]),
        },
    });
    const rootUri = { fsPath: '/fixture', toString: () => '/fixture' };
    const result = await provider.runGitSync(rootUri, 'pull', message => progress.push(message), undefined, { fetch: ['upstream'], pull: ['upstream', 'backup'] });
    nodeAssert.deepEqual(pullRemotes, ['upstream', 'backup'], 'pull runs every remote checked in the Remote selector');
    nodeAssert.equal(result.headChanged, false);
    nodeAssert.equal(result.submodulesNeedUpdate, true, 'a no-op pull still checks submodule state');
    nodeAssert.deepEqual(result.submodulePaths, ['modules/stale', 'modules/missing']);
    nodeAssert.equal(result.summary, '拉取完成：当前分支已是最新（aaaaaaaa）');
    nodeAssert.ok(progress.includes('正在检查子模块是否需要更新...'));

    const updateProgress = [];
    await provider.updateGitSubmodules(rootUri, result.submodulePaths, message => updateProgress.push(message));
    nodeAssert.deepEqual(updateCalls, [['modules/stale'], ['modules/missing']], 'submodules update one at a time');
    nodeAssert.deepEqual(updateProgress, [
        '正在更新子模块（1/2）：modules/stale',
        '子模块更新完成（1/2）：modules/stale',
        '正在更新子模块（2/2）：modules/missing',
        '子模块更新完成（2/2）：modules/missing',
    ]);
}

async function testPullChecksNestedUninitializedSubmodulesWithoutHeadChange() {
    const rootPath = 'C:\\fixture';
    const childPath = 'C:\\fixture\\modules\\parent';
    const nestedLeftPath = `${childPath}\\nested\\left`;
    const nestedRightPath = `${childPath}\\nested\\right`;
    const progress = [];
    const updateCalls = [];
    const nestedScanStarts = [];
    const nestedScanResolvers = new Map();
    const head = 'a'.repeat(40);
    const invokeNativeGit = async (operation, payload) => {
        if (operation === 'head') return { hash: head };
        if (operation === 'branches') return { local: [], remote: [] };
        if (operation === 'discover') return { workdir: payload.path };
        if (operation === 'submodules' && payload.rootPath === rootPath) return [
            {
                path: 'modules/parent',
                absolutePath: childPath,
                indexId: '1'.repeat(40),
                workdirId: '1'.repeat(40),
            },
        ];
        if (operation === 'submodules' && payload.rootPath === childPath) return [
            {
                path: 'nested/left',
                absolutePath: nestedLeftPath,
                indexId: '2'.repeat(40),
                workdirId: '2'.repeat(40),
            },
            {
                path: 'nested/right',
                absolutePath: nestedRightPath,
                indexId: '3'.repeat(40),
                workdirId: '3'.repeat(40),
            },
        ];
        if (operation === 'submodules' && (payload.rootPath === nestedLeftPath || payload.rootPath === nestedRightPath)) {
            nestedScanStarts.push(payload.rootPath);
            return new Promise(resolve => nestedScanResolvers.set(payload.rootPath, resolve));
        }
        throw new Error(`Unexpected native operation: ${operation}`);
    };
    const provider = loadFresh('../out/git/gitLogProvider', {
        vscode: { Uri: { file: fsPath => ({ fsPath, toString: () => fsPath }) } },
        './nativeGitBinding': { invokeNativeGit },
        './gitNativeOperations': {
            fetchRemotes: async () => {},
            pull: async () => {},
            push: async () => ({}),
            updateSubmodules: async (_rootUri, paths) => updateCalls.push([...paths]),
        },
    });
    const rootUri = { fsPath: rootPath, toString: () => rootPath };
    const pending = provider.runGitSync(rootUri, 'pull', message => progress.push(message), undefined, { fetch: ['origin'], pull: ['origin'] });
    await new Promise(resolve => setImmediate(resolve));
    nodeAssert.deepEqual([...nestedScanStarts].sort(), [nestedLeftPath, nestedRightPath].sort(),
        'sibling repositories at the same recursive level are checked concurrently');

    nestedScanResolvers.get(nestedLeftPath)([
        {
            path: 'missing',
            absolutePath: `${nestedLeftPath}\\missing`,
            indexId: '4'.repeat(40),
            workdirId: null,
        },
    ]);
    nestedScanResolvers.get(nestedRightPath)([]);
    const result = await pending;
    nodeAssert.equal(result.headChanged, false);
    nodeAssert.equal(result.submodulesNeedUpdate, true);
    nodeAssert.deepEqual(result.submodulePaths, ['modules/parent'],
        'a deeply nested uninitialized module selects its top-level owner for recursive update');
    nodeAssert.ok(progress.includes('正在检查子模块是否需要更新...'));

    await provider.updateGitSubmodules(rootUri, result.submodulePaths);
    nodeAssert.deepEqual(updateCalls, [['modules/parent']],
        'updating the top-level owner lets --init --recursive initialize nested modules safely');
}

async function testPullPromptsBeforeUpdatingSubmodules() {
    let answer = '更新子模块';
    let events = [];
    const updateCalls = [];
    const syncCalls = [];
    const result = {
        headChanged: false,
        submodulesNeedUpdate: true,
        submoduleTopologyChanged: false,
        submodulePaths: ['modules/stale', 'modules/missing'],
        summary: '拉取完成：当前分支已是最新（aaaaaaaa）',
        details: [],
    };
    const vscode = {
        ProgressLocation: { Notification: 15 },
        window: {
            withProgress: async (options, task) => {
                events.push(['start', options]);
                return task({ report: value => events.push(['progress', value.message]) });
            },
            showWarningMessage: async (...args) => {
                events.push(['prompt', ...args]);
                return answer;
            },
            showInformationMessage: message => events.push(['information', message]),
            showErrorMessage: message => events.push(['error', message]),
        },
        env: { clipboard: { writeText: async () => {} } },
    };
    const actions = loadFresh('../out/services/gitActions', {
        vscode,
        '../git/gitLogProvider': {
            getPushBranches: async () => [],
            runGitSync: async (...args) => { syncCalls.push(args); return result; },
            updateGitSubmodules: async (_rootUri, paths, onProgress) => {
                updateCalls.push([...paths]);
                for (const path of paths) onProgress(`正在更新子模块：${path}`);
            },
        },
        '../git/gitNativeOperations': {
            checkout: async () => {}, cherryPick: async () => {}, createBranch: async () => {}, createTag: async () => {},
            merge: async () => {}, rebase: async () => {}, reset: async () => {}, revertCommit: async () => {},
            stageAll: async () => {}, statusSummary: async () => ({ hasStagedChanges: false, hasUnstagedChanges: false }),
        },
        '../webview/gitCommitEditMsgEditor': { GitCommitEditMsgEditor: class {} },
        './pushDialogs': {
            confirmPush: async () => true, pickPushBranches: async () => [], showPushResult: async () => {},
        },
    });
    const mutated = [];
    const runner = new actions.GitActionRunner(
        () => ({ fsPath: '/fixture' }),
        async (...args) => mutated.push(args),
        {},
    );

    await runner.syncRepository('pull', '/fixture', { fetch: ['origin'], pull: ['origin'] });
    const prompt = events.find(event => event[0] === 'prompt');
    nodeAssert.ok(prompt, 'a no-op pull still prompts when submodules are stale');
    nodeAssert.ok(prompt[1].includes('2 个子模块版本不一致'));
    nodeAssert.equal(prompt[2].modal, true);
    nodeAssert.ok(prompt[2].detail.includes('modules/stale'));
    nodeAssert.ok(prompt[2].detail.includes('modules/missing'));
    nodeAssert.deepEqual(updateCalls, [['modules/stale', 'modules/missing']]);
    nodeAssert.ok(events.some(event => event[0] === 'progress' && event[1].includes('modules/stale')));
    nodeAssert.ok(events.some(event => event[0] === 'information'
        && event[1] === '拉取完成：当前分支已是最新（aaaaaaaa）；已更新 2 个子模块。'));

    answer = '暂不更新';
    events = [];
    await runner.syncRepository('pull', '/fixture', { fetch: ['origin'], pull: ['origin'] });
    nodeAssert.equal(updateCalls.length, 1, 'declining the prompt does not update submodules');
    nodeAssert.ok(events.some(event => event[0] === 'information'
        && event[1] === '拉取完成：当前分支已是最新（aaaaaaaa）；有 2 个子模块暂未更新。'));
    nodeAssert.equal(mutated.length, 2);
    nodeAssert.deepEqual(syncCalls.map(call => call[4].pull), [['origin'], ['origin']], 'GitActionRunner forwards the Remote selector value to Pull');
}

async function testMultiRemotePullConfirmation() {
    const events = [];
    const syncCalls = [];
    let answer;
    let confirmPending;
    let failSync = false;
    const vscode = {
        ProgressLocation: { Notification: 15 },
        window: {
            withProgress: async (_options, task) => {
                events.push(['start']);
                return task({ report() {} });
            },
            showWarningMessage: async (...args) => {
                events.push(['warning', ...args]);
                if (!args[1]?.modal) { return undefined; }
                if (answer === 'pending') { return new Promise(resolve => { confirmPending = resolve; }); }
                return answer;
            },
            showInformationMessage: message => events.push(['information', message]),
            showErrorMessage: message => events.push(['error', message]),
        },
    };
    const actions = loadFresh('../out/services/gitActions', {
        vscode,
        '../git/gitLogProvider': {
            runGitSync: async (...args) => {
                events.push(['sync', args[1]]);
                syncCalls.push(args);
                if (failSync) { throw new Error('pull failed'); }
                return { headChanged: false, submodulesNeedUpdate: false, submoduleTopologyChanged: false, submodulePaths: [], summary: '拉取完成' };
            },
        },
        '../git/gitNativeOperations': {},
        '../webview/gitCommitEditMsgEditor': { GitCommitEditMsgEditor: class {} },
        './pushDialogs': {},
    });
    const runner = new actions.GitActionRunner(
        () => ({ fsPath: '/fixture' }),
        async () => { events.push(['mutated']); },
        {},
    );
    const remotes = { fetch: ['origin'], pull: ['origin', 'upstream', 'backup'] };
    for (const count of [2, 3]) {
        for (answer of [undefined, '取消']) {
            events.length = 0;
            await runner.syncRepository('pull', '/fixture', { ...remotes, pull: remotes.pull.slice(0, count) });
            const warnings = events.filter(event => event[0] === 'warning');
            nodeAssert.equal(warnings.length, 1, 'each multi-remote Pull asks once before running');
            nodeAssert.equal(warnings[0][1], `已勾选 ${count} 个 Pull remote，是否继续拉取？`);
            nodeAssert.equal(warnings[0][2].modal, true);
            nodeAssert.equal(warnings[0][3], '继续拉取');
            nodeAssert.ok(warnings[0][2].detail.includes(remotes.pull.slice(0, count).map(remote => '• ' + remote).join('\n')), 'the confirmation lists every remote in execution order');
            nodeAssert.ok(warnings[0][2].detail.includes('冲突'));
            nodeAssert.ok(warnings[0][2].detail.includes('不会自动撤销'));
            nodeAssert.equal(events.some(event => ['start', 'sync', 'mutated'].includes(event[0])), false, 'cancel/dismiss does not start progress, Git, or refresh');
        }
    }
    nodeAssert.equal(syncCalls.length, 0);

    answer = '继续拉取';
    events.length = 0;
    await runner.syncRepository('pull', '/fixture', remotes);
    nodeAssert.deepEqual(events.slice(0, 3).map(event => event[0]), ['warning', 'start', 'sync'], 'confirmation happens before progress and any Git operation');
    nodeAssert.deepEqual(syncCalls[0][4].pull, remotes.pull, 'confirming preserves all checked remotes and their order');

    const single = { ...remotes, pull: ['origin'] };
    events.length = 0;
    await runner.syncRepository('pull', '/fixture', single);
    nodeAssert.equal(events.some(event => event[0] === 'warning'), false, 'one Pull remote needs no new confirmation');
    events.length = 0;
    await runner.syncRepository('fetch', '/fixture', remotes);
    nodeAssert.equal(events.some(event => event[0] === 'warning'), false, 'Fetch does not confirm even when multiple Pull remotes are checked');

    answer = 'pending';
    events.length = 0;
    const beforePending = syncCalls.length;
    const pending = runner.syncRepository('pull', '/fixture', remotes);
    await new Promise(resolve => setImmediate(resolve));
    nodeAssert.equal(syncCalls.length, beforePending, 'no Git operation runs while confirmation is open');
    await runner.syncRepository('pull', '/fixture', single);
    nodeAssert.equal(events.at(-1)[1], '已有 Git 同步操作正在进行，请稍候。');
    nodeAssert.equal(syncCalls.length, beforePending, 'a second click cannot bypass the pending confirmation');
    confirmPending(undefined);
    await pending;
    await runner.syncRepository('pull', '/fixture', single);
    nodeAssert.equal(syncCalls.length, beforePending + 1, 'cancelling releases the sync lock');

    answer = '继续拉取';
    failSync = true;
    events.length = 0;
    await runner.syncRepository('pull', '/fixture', remotes);
    nodeAssert.ok(events.some(event => event[0] === 'error' && event[1].includes('pull failed')));
    failSync = false;
    const afterFailure = syncCalls.length;
    await runner.syncRepository('pull', '/fixture', single);
    nodeAssert.equal(syncCalls.length, afterFailure + 1, 'a failed confirmed Pull also releases the sync lock');
}

async function testPushUsesExplicitTargetsWithoutRemoteCheckboxes() {
    const pushes = [];
    const sourceHash = 'a'.repeat(40);
    const target = { remote: 'upstream', branch: 'develop', remoteName: 'upstream/develop', isUpstream: false, tipTimestamp: 1, unpushedCommitCount: 1 };
    const provider = loadFresh('../out/git/gitLogProvider', {
        vscode: { Uri: { file: fsPath => ({ fsPath, toString: () => fsPath }) } },
        './nativeGitBinding': { invokeNativeGit: async operation => {
            if (operation === 'pushBranches') return [];
            if (operation === 'head') return { hash: sourceHash, branch: 'main' };
            throw new Error(`Unexpected native operation: ${operation}`);
        } },
        './gitNativeOperations': {
            fetchRemotes: async () => {}, pull: async () => {}, updateSubmodules: async () => {},
            push: async (_rootUri, request) => { pushes.push(request); return request; },
        },
    });
    const rootUri = { fsPath: '/fixture', toString: () => '/fixture' };
    await provider.runGitSync(rootUri, 'push', undefined, [target], { fetch: ['origin'], pull: ['origin'] });
    nodeAssert.deepEqual(pushes, [{
        remote: 'upstream', remoteBranch: 'develop', sourceBranchName: 'main', sourceHash,
    }], 'the target dialog selection is the sole authority for the Push destination');
}

async function testPushTargetDialogOwnsRemoteSelection() {
    const selectedPlans = [];
    const pickerArgumentCounts = [];
    const confirmationCalls = [];
    const syncCalls = [];
    const plan = {
        source: { branchName: 'main', hash: 'a'.repeat(40) },
        targets: [
            { remote: 'origin', branch: 'main', remoteName: 'origin/main', isUpstream: true, tipTimestamp: 2, unpushedCommitCount: 1 },
            { remote: 'upstream', branch: 'develop', remoteName: 'upstream/develop', isUpstream: false, tipTimestamp: 1, unpushedCommitCount: 1 },
        ],
    };
    const vscode = {
        ProgressLocation: { Notification: 15 },
        window: {
            withProgress: async (_options, task) => task({ report() {} }),
            showWarningMessage: async () => undefined,
            showInformationMessage() {},
            showErrorMessage(message) { throw new Error(message); },
        },
        env: { clipboard: { writeText: async () => {} } },
    };
    const actions = loadFresh('../out/services/gitActions', {
        vscode,
        '../git/gitLogProvider': {
            getPushPlan: async () => plan,
            runGitSync: async (...args) => { syncCalls.push(args); return { pushResults: [] }; },
            updateGitSubmodules: async () => {},
        },
        '../git/gitNativeOperations': {
            checkout: async () => {}, cherryPick: async () => {}, createBranch: async () => {}, createTag: async () => {},
            merge: async () => {}, rebase: async () => {}, reset: async () => {}, revertCommit: async () => {},
            stageAll: async () => {}, statusSummary: async () => ({ hasStagedChanges: false, hasUnstagedChanges: false }),
        },
        '../webview/gitCommitEditMsgEditor': { GitCommitEditMsgEditor: class {} },
        './pushDialogs': {
            pickPushTargets: async (...args) => { selectedPlans.push(args[0]); pickerArgumentCounts.push(args.length); return plan.targets; },
            confirmPush: async (...args) => { confirmationCalls.push(args); return true; },
            showPushResult: async () => {},
        },
    });
    const runner = new actions.GitActionRunner(() => ({ fsPath: '/fixture' }), async () => {}, {});
    await runner.syncRepository('push', '/fixture', { fetch: ['origin', 'upstream'], pull: ['origin', 'upstream'] });
    nodeAssert.deepEqual(selectedPlans[0].targets.map(target => target.remoteName), ['origin/main', 'upstream/develop'], 'Push dialog owns remote selection and includes every existing remote branch');
    nodeAssert.equal(pickerArgumentCounts[0], 1, 'Push opens the branch picker without a default-selected current remote branch');
    nodeAssert.equal(confirmationCalls[0][1], 'fixture', 'Push confirmation displays the repository name');
    nodeAssert.deepEqual(confirmationCalls[0][2], ['origin', 'upstream'], 'Push confirmation derives remotes from the branches selected in the target dialog');
    nodeAssert.equal(syncCalls[0][4].push, undefined, 'Push execution no longer receives Remote-selector checkbox state');
    nodeAssert.deepEqual(syncCalls[0][3].map(target => target.remoteName), ['origin/main', 'upstream/develop']);
}

async function main() {
    await testFetchesRootAndSubmodulesInParallel();
    await testPullChecksStaleSubmodulesWithoutHeadChange();
    await testPullChecksNestedUninitializedSubmodulesWithoutHeadChange();
    await testPullPromptsBeforeUpdatingSubmodules();
    await testMultiRemotePullConfirmation();
    await testPushUsesExplicitTargetsWithoutRemoteCheckboxes();
    await testPushTargetDialogOwnsRemoteSelection();
    console.log('Fetch/Pull submodule flow: parallel fetch, recursive no-op check, multi-remote Pull confirmation/cancel, sync lock, initialization, per-module progress, updated/skipped copy passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
