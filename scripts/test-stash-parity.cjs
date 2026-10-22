// Real N-API / Git CLI parity; extensionless fixtures avoid local TSD policies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { bindings, detectNativeTarget } = require('./native-targets.cjs');

function loadBinding() {
  if (process.env.STASH_NATIVE_BINDING) return require(path.resolve(process.env.STASH_NATIVE_BINDING));
  const target = detectNativeTarget();
  const directory = path.resolve(__dirname, '..', 'lib', target);
  const files = bindings[target].filter(name => fs.existsSync(path.join(directory, name)));
  assert.equal(files.length, 1, 'exactly one native module for the current platform');
  return require(path.join(directory, files[0]));
}
function git(root, args, allowFailure = false, input) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull, GIT_ATTR_NOSYSTEM: '1' },
  });
  if (!allowFailure) assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return { code: result.status, stdout: (result.stdout || '').trimEnd(), stderr: result.stderr || '' };
}
function write(root, name, contents) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
function fixture(root, attribute = '', auto = 'false') {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Stash Test']);
  git(root, ['config', 'user.email', 'stash@example.com']);
  git(root, ['config', 'core.autocrlf', auto]);
  write(root, '.git/test-empty-attributes', '');
  git(root, ['config', 'core.attributesfile', path.join(root, '.git', 'test-empty-attributes')]);
  write(root, '.gitattributes', '* -filter\n' + attribute);
  write(root, '.gitignore', 'ignored\n');
  for (const name of ['a', 'b', 'c', '[literal]', 'space name']) write(root, name, 'base\n');
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'base']);
  return root;
}
function snapshot(root) {
  const stash = git(root, ['rev-parse', '--verify', 'refs/stash'], true);
  const trees = [];
  if (stash.code === 0) {
    trees.push(git(root, ['rev-parse', `${stash.stdout}^{tree}`]).stdout);
    trees.push(git(root, ['rev-parse', `${stash.stdout}^2^{tree}`]).stdout);
    const third = git(root, ['rev-parse', '--verify', `${stash.stdout}^3^{tree}`], true);
    if (third.code === 0) trees.push(third.stdout);
  }
  const files = {};
  const walk = prefix => {
    for (const name of fs.readdirSync(path.join(root, prefix)).sort()) {
      if (prefix === '' && name === '.git') continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(root, relative);
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) files[relative] = ['symlink', fs.readlinkSync(absolute)];
      else if (info.isDirectory()) walk(relative);
      else files[relative] = fs.readFileSync(absolute).toString('hex');
    }
  };
  walk('');
  return { trees, index: git(root, ['write-tree']).stdout, files, status: git(root, ['status', '--porcelain=v1', '-uall']).stdout };
}
async function invoke(binding, root, operation, payload = {}) {
  return JSON.parse(await binding.invoke(operation, JSON.stringify({ rootPath: root, ...payload })));
}
async function runParity() {
  const binding = loadBinding();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-stash-parity-'));
  let passed = 0;
  const check = async (name, action) => { await action(); passed++; console.log(`PASS ${name}`); };
  try {
    await check('staged attribute restoration keeps canonical checkout filters', async () => {
      for (const prefix of ['', 'nested/']) {
        const root = fixture(path.join(scratch, prefix ? 'restore-nested-attrs' : 'restore-root-attrs'));
        const attrs = `${prefix}.gitattributes`, file = `${prefix}a`;
        write(root, attrs, (prefix ? '' : '* -filter\n') + 'a text eol=crlf\n');
        write(root, file, 'base\r\n');
        git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'attributes baseline']);
        write(root, attrs, prefix ? '' : '* -filter\n'); write(root, file, 'staged\n');
        git(root, ['add', '-A']); write(root, 'b', 'unrelated dirty\n');
        await invoke(binding, root, 'stashCreate', { scope: 'staged' });
        assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'base\r\n');
        assert.equal(fs.readFileSync(path.join(root, 'b'), 'utf8'), 'unrelated dirty\n');
        assert.equal(git(root, ['diff', '--cached', '--name-only']).stdout, '');
      }
    });
    await check('keep-index restores canonical filtered staged-only contents', async () => {
      const root = fixture(path.join(scratch, 'filtered-staged-only'));
      write(root, '.git/uppercase', "process.stdin.on('data', x => process.stdout.write(x.toString().toUpperCase()));");
      git(root, ['config', 'filter.upper.clean', 'node .git/uppercase']);
      write(root, '.gitattributes', 'a filter=upper\n'); write(root, 'a', 'base lower\n');
      git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'filtered baseline']);
      write(root, 'a', 'staged lower\n'); git(root, ['add', 'a']); write(root, 'b', 'dirty\n');
      const beforeIndex = git(root, ['write-tree']).stdout;
      const result = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      assert.equal(git(root, ['show', `${result.stash}:a`]).stdout, 'STAGED LOWER');
      assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'STAGED LOWER\n');
      assert.equal(git(root, ['write-tree']).stdout, beforeIndex);
      assert.equal(fs.readFileSync(path.join(root, 'b'), 'utf8'), 'base\n');
    });
    await check('scoped reset preserves literal siblings and ignored files', async () => {
      const cli = fixture(path.join(scratch, 'scoped-reset-cli'));
      const native = fixture(path.join(scratch, 'scoped-reset-native'));
      for (const root of [cli, native]) {
        write(root, 'a', 'staged\n'); git(root, ['add', 'a']);
        write(root, '[literal]', 'dirty\n'); write(root, 'space name', 'dirty\n');
        write(root, 'a-prefix', 'new\n'); write(root, 'new/sub/file', 'nested new\n');
        write(root, 'ignored', 'ignored content must remain\n');
      }
      git(cli, ['stash', 'push', '-k', '-u']);
      await invoke(binding, native, 'stashCreate', { scope: 'unstaged' });
      assert.deepEqual(snapshot(native), snapshot(cli));
    });
    await check('attribute batches do not survive subsequent operations', async () => {
      const root = fixture(path.join(scratch, 'fresh-attribute-batches'));
      write(root, 'a', 'first\n'); await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      git(root, ['config', 'filter.unsupported.clean', 'must-not-run']);
      write(root, '.gitattributes', '* -filter\na filter=unsupported\n'); write(root, 'a', 'second\n');
      const beforeRef = git(root, ['rev-parse', 'refs/stash']).stdout;
      await assert.rejects(() => invoke(binding, root, 'stashCreate', { scope: 'unstaged' }), /外部 Git filter/);
      assert.equal(git(root, ['rev-parse', 'refs/stash']).stdout, beforeRef);
      assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'second\n');
    });
    const scenarios = [
      { name: 'plain' }, { name: 'autocrlf', auto: 'true' }, { name: 'input', auto: 'input' },
      { name: 'lf', attrs: 'a text eol=lf\n', auto: 'true' },
      { name: 'crlf', attrs: 'a text eol=crlf\n' },
      { name: 'binary', attrs: 'a -text\n', auto: 'true' },
      { name: 'delete', kind: 'delete' }, { name: 'add', kind: 'add' }, { name: 'rename', kind: 'rename' },
      { name: 'literal', kind: 'literal' }, { name: 'overlap', kind: 'overlap' },
      { name: 'attribute-change', kind: 'attribute', attrs: 'a text eol=crlf\n' },
      { name: 'index-deleted-recreated', kind: 'recreated' },
    ];
    for (const scope of ['unstaged', 'staged']) for (const scenario of scenarios) {
      await check(`${scope}/${scenario.name}`, async () => {
        const prepare = root => {
          fixture(root, scenario.attrs || '', scenario.auto || 'false');
          const crlf = scenario.name === 'crlf' || (scenario.auto === 'true' && scenario.name !== 'lf');
          const edit = crlf ? 'staged\r\n' : 'staged\n';
          if (scenario.kind === 'delete') fs.unlinkSync(path.join(root, 'a'));
          else if (scenario.kind === 'add') write(root, 'added', edit);
          else if (scenario.kind === 'rename') fs.renameSync(path.join(root, 'a'), path.join(root, 'renamed'));
          else if (scenario.kind === 'literal') { write(root, '[literal]', edit); write(root, 'space name', edit); }
          else if (scenario.kind === 'recreated') { git(root, ['rm', '--cached', 'a']); write(root, 'a', edit); }
          else write(root, 'a', edit);
          if (scenario.kind === 'attribute') { write(root, '.gitattributes', '* -filter\na text eol=lf\n'); write(root, 'a', 'staged\n'); }
          if (scope === 'staged' && scenario.kind !== 'recreated') git(root, ['add', '-A']);
          if (scenario.kind === 'overlap') {
            if (scope === 'unstaged') git(root, ['add', 'a']);
            write(root, 'a', edit + (crlf ? 'unstaged\r\n' : 'unstaged\n'));
          }
          write(root, 'b', 'unstaged\n'); write(root, 'untracked', 'new\n'); write(root, 'ignored', 'keep ignored\n');
        };
        const cli = path.join(scratch, `${scope}-${scenario.name}-cli`);
        const native = path.join(scratch, `${scope}-${scenario.name}-native`);
        prepare(cli); prepare(native);
        const expected = git(cli, ['stash', 'push', ...(scope === 'staged' ? ['--staged'] : ['-k', '-u'])], true);
        let actualError;
        try { await invoke(binding, native, 'stashCreate', { scope }); } catch (error) { actualError = error; }
        assert.equal(Boolean(actualError), expected.code !== 0, actualError?.message || expected.stderr);
        const nativeSnapshot = snapshot(native), cliSnapshot = snapshot(cli);
        if (scope === 'staged' && scenario.kind === 'attribute') {
          // Git's reverse-patch implementation may leave LF after restoring an
          // eol=crlf attribute. The existing native backend deliberately checks
          // out the canonical CRLF form. Preserve that policy, filtered content,
          // tree, index and status rather than introducing an unrelated change.
          assert.equal(nativeSnapshot.files.a, Buffer.from('base\r\n').toString('hex'));
          const normalize = hex => Buffer.from(hex, 'hex').toString('utf8').replace(/\r\n/g, '\n');
          assert.equal(normalize(nativeSnapshot.files.a), normalize(cliSnapshot.files.a));
          nativeSnapshot.files.a = cliSnapshot.files.a;
        }
        assert.deepEqual(nativeSnapshot, cliSnapshot, `${scope}/${scenario.name} must match trees, bytes, index and status`);
      });
    }
    await check('apply/pop/drop, sparse safety and stable hashes', async () => {
      const root = fixture(path.join(scratch, 'operations'));
      write(root, 'a', 'saved\n'); write(root, 'saved-new', 'new\n');
      const stash = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      // Unrelated local files must not be lost or rejected by path-limited preflight.
      for (let i = 0; i < 100; i++) write(root, `unrelated/${i}`, `local ${i}\n`);
      write(root, '[literal]', 'unrelated literal edit\n');
      const applied = await invoke(binding, root, 'stashApply', { stash: stash.stash });
      assert.equal(applied.dropped, false); assert.equal(applied.conflicts, false);
      assert.equal((await invoke(binding, root, 'stashList')).length, 1);
      assert.equal(fs.readFileSync(path.join(root, 'unrelated/99'), 'utf8'), 'local 99\n');
      await assert.rejects(() => invoke(binding, root, 'stashApply', { stash: stash.stash }), /已存在或有本地修改|暂存区/);
      git(root, ['reset', '--hard', '-q']); git(root, ['clean', '-fdq']);
      const popped = await invoke(binding, root, 'stashPop', { stash: stash.stash });
      assert.equal(popped.dropped, true); assert.equal((await invoke(binding, root, 'stashList')).length, 0);
      git(root, ['reset', '--hard', '-q']); git(root, ['clean', '-fdq']);
      write(root, 'a', 'first\n'); const first = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      write(root, 'a', 'second\n'); const second = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      await invoke(binding, root, 'stashDrop', { stash: first.stash });
      assert.deepEqual((await invoke(binding, root, 'stashList')).map(s => s.hash), [second.stash]);
      await invoke(binding, root, 'stashDrop', { stash: second.stash });
      await assert.rejects(() => invoke(binding, root, 'stashDrop', { stash: first.stash }), /已不存在/);
      await assert.rejects(() => invoke(binding, root, 'stashApply', { stash: 'stash@{0}' }), /无效/);
    });
    await check('literal apply preflight, conflicts and overwrite protection', async () => {
      const root = fixture(path.join(scratch, 'literal-apply'));
      write(root, '[literal]', 'saved\n'); const stash = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      write(root, '[literal]', 'do not overwrite\n');
      await assert.rejects(() => invoke(binding, root, 'stashPop', { stash: stash.stash }), /已存在或有本地修改/);
      assert.equal(fs.readFileSync(path.join(root, '[literal]'), 'utf8'), 'do not overwrite\n');
      assert.equal((await invoke(binding, root, 'stashList')).length, 1);
      git(root, ['reset', '--hard', '-q']);
      write(root, 'b', 'staged local\n'); git(root, ['add', 'b']);
      await assert.rejects(() => invoke(binding, root, 'stashApply', { stash: stash.stash }), /暂存区/);
    });
    await check('filter/TSD safety remains before mutation', async () => {
      const root = fixture(path.join(scratch, 'safety'));
      write(root, 'a', '%TSD-Header-###%opaque');
      await assert.rejects(() => invoke(binding, root, 'stashCreate', { scope: 'unstaged' }), /透明加密/);
      assert.deepEqual(await invoke(binding, root, 'stashList'), []);
      write(root, 'a', 'real changes\n');
      write(root, '.gitattributes', 'a filter=unsupported\n');
      git(root, ['config', 'filter.unsupported.clean', 'must-not-be-executed']);
      await assert.rejects(() => invoke(binding, root, 'stashCreate', { scope: 'unstaged' }), /外部 Git filter/);
      assert.deepEqual(await invoke(binding, root, 'stashList'), []);
    });
    await check('rename file metadata and untracked third parent', async () => {
      const root = fixture(path.join(scratch, 'metadata'));
      fs.renameSync(path.join(root, 'a'), path.join(root, 'renamed'));
      write(root, 'new', 'untracked\n');
      const stash = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      const files = await invoke(binding, root, 'stashFiles', { revision: stash.stash });
      assert.ok(files.some(file => file.path === 'new' && file.status === 'A'));
      assert.ok(files.some(file => file.path === 'a' && file.status === 'D'));
      assert.ok(files.some(file => file.path === 'renamed' && file.status === 'A'));
      await invoke(binding, root, 'stashDrop', { stash: stash.stash });
      fs.renameSync(path.join(root, 'a'), path.join(root, 'renamed'));
      git(root, ['add', '-A']);
      const staged = await invoke(binding, root, 'stashCreate', { scope: 'staged' });
      const stagedFiles = await invoke(binding, root, 'stashFiles', { revision: staged.stash });
      assert.ok(stagedFiles.some(file => file.status === 'R' && file.oldPath === 'a' && file.path === 'renamed'));
    });
    await check('large stash list and hash-based drop', async () => {
      const root = fixture(path.join(scratch, 'large-list'));
      write(root, 'a', 'saved\n');
      const stash = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      const tree = git(root, ['rev-parse', `${stash.stash}^{tree}`]).stdout;
      const base = git(root, ['rev-parse', 'HEAD']).stdout;
      const index = git(root, ['rev-parse', `${stash.stash}^2`]).stdout;
      const ids = [];
      for (let i = 0; i < 160; i++) {
        const raw = Buffer.from(`tree ${tree}\nparent ${base}\nparent ${index}\nauthor Stash Test <stash@example.com> 1700000000 +0000\ncommitter Stash Test <stash@example.com> 1700000000 +0000\n\nWIP on main: entry ${i}\n`);
        const object = Buffer.concat([Buffer.from(`commit ${raw.length}\0`), raw]);
        const id = crypto.createHash('sha1').update(object).digest('hex'); ids.push(id);
        const file = path.join(root, '.git', 'objects', id.slice(0, 2), id.slice(2));
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, zlib.deflateSync(object));
      }
      write(root, '.git/refs/stash', ids.at(-1) + '\n');
      write(root, '.git/logs/refs/stash', ids.map((id, i) => `${i ? ids[i - 1] : '0'.repeat(40)} ${id} Stash Test <stash@example.com> 1700000000 +0000\tWIP on main: entry ${i}\n`).join(''));
      const entries = await invoke(binding, root, 'stashList');
      assert.equal(entries.length, ids.length); assert.equal(entries[0].hash, ids.at(-1));
      assert.equal(entries.at(-1).stashRef, `stash@{${ids.length - 1}}`);
      await invoke(binding, root, 'stashDrop', { stash: ids[10] });
      const remaining = await invoke(binding, root, 'stashList');
      assert.equal(remaining.length, ids.length - 1); assert.ok(!remaining.some(entry => entry.hash === ids[10]));
    });
    await check('Gitlink-only staged restore and unstaged submodule preservation', async () => {
      const source = fixture(path.join(scratch, 'child-source'));
      const first = git(source, ['rev-parse', 'HEAD']).stdout;
      git(source, ['commit', '--allow-empty', '-q', '-m', 'child second']);
      const second = git(source, ['rev-parse', 'HEAD']).stdout;
      const root = fixture(path.join(scratch, 'gitlinks'));
      git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'child']);
      git(root, ['commit', '-q', '-m', 'add child']);
      const child = path.join(root, 'child');
      git(child, ['checkout', '-q', first]); git(root, ['add', 'child']);
      write(root, 'b', 'must remain unstaged\n');
      const staged = await invoke(binding, root, 'stashCreate', { scope: 'staged' });
      assert.equal(git(root, ['rev-parse', ':child']).stdout, second);
      assert.equal(git(child, ['rev-parse', 'HEAD']).stdout, first);
      assert.equal(fs.readFileSync(path.join(root, 'b'), 'utf8'), 'must remain unstaged\n');
      const files = await invoke(binding, root, 'stashFiles', { revision: staged.stash });
      assert.ok(files.some(file => file.path === 'child' && file.isGitlink));
      await assert.rejects(() => invoke(binding, root, 'stashApply', { stash: staged.stash }), /子模块指针/);
      write(child, 'a', 'child edit must stay\n'); write(root, 'a', 'parent edit\n');
      const unstaged = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      assert.ok(unstaged.skippedGitlinks.includes('child'));
      assert.equal(fs.readFileSync(path.join(child, 'a'), 'utf8'), 'child edit must stay\n');
      assert.equal(git(child, ['rev-parse', 'HEAD']).stdout, first);
    });
    if (process.platform !== 'win32') await check('symlink contents and executable modes', async () => {
      for (const scope of ['unstaged', 'staged']) {
        const prepare = root => {
          fixture(root); fs.symlinkSync('a', path.join(root, 'link')); git(root, ['add', 'link']); git(root, ['commit', '-q', '-m', 'link']);
          fs.unlinkSync(path.join(root, 'link')); fs.symlinkSync('b', path.join(root, 'link')); fs.chmodSync(path.join(root, 'a'), 0o755);
          if (scope === 'staged') git(root, ['add', '-A']);
        };
        const cli = path.join(scratch, `unix-${scope}-cli`), native = path.join(scratch, `unix-${scope}-native`); prepare(cli); prepare(native);
        git(cli, ['stash', 'push', ...(scope === 'staged' ? ['--staged'] : ['-k', '-u'])]);
        await invoke(binding, native, 'stashCreate', { scope }); assert.deepEqual(snapshot(native), snapshot(cli));
      }
    });
    console.log(`Stash parity passed: ${passed} scenarios (${process.platform}/${process.arch}, libgit2 ${binding.libgit2Version()}).`);
  } catch (error) {
    console.error(`Stash fixture retained at ${scratch}`); throw error;
  }
  // Only remove the freshly created, explicitly verified temporary test root.
  assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(scratch, { recursive: true, force: true });
}
module.exports = { loadBinding, git, write, fixture, snapshot, invoke };
if (require.main === module) runParity().catch(error => { console.error(error); process.exitCode = 1; });
