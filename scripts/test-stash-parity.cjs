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
function rawStashFiles(root, revision) {
  const raw = git(root, ['stash', 'show', '--include-untracked', '--raw', '-z', '--no-abbrev', '--find-renames', revision]).stdout;
  const values = raw.split('\0');
  const files = [];
  for (let index = 0; index < values.length;) {
    const header = values[index++];
    if (!header) continue;
    const [oldMode, newMode, oldObjectId, newObjectId, statusText] = header.slice(1).split(' ');
    const oldPath = values[index++];
    const renamed = statusText[0] === 'R' || statusText[0] === 'C';
    const filePath = renamed ? values[index++] : oldPath;
    files.push({
      path: filePath, status: statusText[0], oldPath: renamed ? oldPath : null,
      oldObjectId, newObjectId, oldMode, newMode,
      isGitlink: oldMode === '160000' || newMode === '160000',
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
async function runParity() {
  const binding = loadBinding();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-stash-parity-'));
  let passed = 0;
  const check = async (name, action) => { await action(); passed++; console.log(`PASS ${name}`); };
  try {
    await check('staged attribute restoration matches Git bytes for root and nested rules', async () => {
      for (const prefix of ['', 'nested/']) {
        const prepare = root => {
          fixture(root);
          const attrs = `${prefix}.gitattributes`, file = `${prefix}a`;
          write(root, attrs, (prefix ? '' : '* -filter\n') + 'a text eol=crlf\n');
          write(root, file, 'base\r\n');
          git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'attributes baseline']);
          write(root, attrs, prefix ? '' : '* -filter\n'); write(root, file, 'staged\n');
          git(root, ['add', '-A']); write(root, 'b', 'unrelated dirty\n');
        };
        const label = prefix ? 'nested' : 'root';
        const cli = path.join(scratch, `restore-${label}-attrs-cli`);
        const native = path.join(scratch, `restore-${label}-attrs-native`);
        prepare(cli); prepare(native);
        const expected = git(cli, ['stash', 'push', '--staged'], true);
        let error; try { await invoke(binding, native, 'stashCreate', { scope: 'staged' }); } catch (caught) { error = caught; }
        assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
        assert.deepEqual(snapshot(native), snapshot(cli));
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
      const prepare = async root => {
        fixture(root);
        write(root, 'a', 'first\n');
        if (root.endsWith('-native')) await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
        else git(root, ['stash', 'push', '-q', '-k', '-u']);
        write(root, '.git/fail.js', 'process.exit(1)');
        git(root, ['config', 'filter.fresh.clean', 'node .git/fail.js']);
        git(root, ['config', 'filter.fresh.required', 'true']);
        write(root, '.gitattributes', '* -filter\na filter=fresh\n'); write(root, 'a', 'second\n');
      };
      const cli = path.join(scratch, 'fresh-attribute-batches-cli');
      const native = path.join(scratch, 'fresh-attribute-batches-native');
      await prepare(cli); await prepare(native);
      const expected = git(cli, ['stash', 'push', '-k', '-u'], true);
      let error; try { await invoke(binding, native, 'stashCreate', { scope: 'unstaged' }); } catch (caught) { error = caught; }
      assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
      assert.deepEqual(snapshot(native), snapshot(cli));
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
      { name: 'file-to-directory', kind: 'file-to-dir' },
      { name: 'mode-and-content', kind: 'mode' },
      { name: 'intent-to-add', kind: 'intent' },
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
          else if (scenario.kind === 'file-to-dir') { fs.unlinkSync(path.join(root, 'a')); write(root, 'a/inside', edit); }
          else if (scenario.kind === 'mode') { git(root, ['update-index', '--chmod=+x', 'a']); write(root, 'a', edit); }
          else if (scenario.kind === 'intent') { write(root, 'ita', 'intent\n'); git(root, ['add', '-N', 'ita']); }
          else write(root, 'a', edit);
          if (scenario.kind === 'attribute') { write(root, '.gitattributes', '* -filter\na text eol=lf\n'); write(root, 'a', 'staged\n'); }
          if (scope === 'staged' && !['recreated', 'intent'].includes(scenario.kind)) git(root, ['add', '-A']);
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
        assert.deepEqual(nativeSnapshot, cliSnapshot, `${scope}/${scenario.name} must match trees, bytes, index and status`);
      });
    }
    await check('no matching changes succeeds without creating a stash', async () => {
      for (const scope of ['unstaged', 'staged']) {
        const cli = fixture(path.join(scratch, `empty-${scope}-cli`));
        const native = fixture(path.join(scratch, `empty-${scope}-native`));
        const expected = git(cli, ['stash', 'push', ...(scope === 'staged' ? ['--staged'] : ['-k', '-u'])], true);
        const result = await invoke(binding, native, 'stashCreate', { scope });
        assert.equal(expected.code, 0);
        assert.equal(result.created, false);
        assert.equal(result.stash, '');
        assert.deepEqual(snapshot(native), snapshot(cli));
      }
    });
    await check('staged stash preserves a separated unstaged hunk in the same file', async () => {
      const prepare = root => {
        fixture(root);
        write(root, 'a', Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join(''));
        git(root, ['add', 'a']); git(root, ['commit', '-q', '-m', 'lines']);
        const staged = Array.from({ length: 20 }, (_, index) => index === 1 ? 'staged line\n' : `line ${index}\n`).join('');
        write(root, 'a', staged); git(root, ['add', 'a']);
        write(root, 'a', staged.replace('line 18\n', 'unstaged line\n'));
      };
      const cli = path.join(scratch, 'separated-hunks-cli'), native = path.join(scratch, 'separated-hunks-native');
      prepare(cli); prepare(native);
      const expected = git(cli, ['stash', 'push', '--staged'], true);
      let error; try { await invoke(binding, native, 'stashCreate', { scope: 'staged' }); } catch (caught) { error = caught; }
      assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
      assert.deepEqual(snapshot(native), snapshot(cli));
    });
    await check('apply and pop preserve non-overlapping staged changes like Git', async () => {
      for (const operation of ['stashApply', 'stashPop']) {
        const prepare = root => {
          fixture(root); write(root, 'a', 'saved\n'); git(root, ['stash', 'push', '-q', '-u']);
          write(root, 'b', 'local staged\n'); git(root, ['add', 'b']);
        };
        const cli = path.join(scratch, `${operation}-staged-cli`), native = path.join(scratch, `${operation}-staged-native`);
        prepare(cli); prepare(native);
        const hash = git(native, ['rev-parse', 'refs/stash']).stdout;
        const expected = git(cli, ['stash', operation === 'stashPop' ? 'pop' : 'apply'], true);
        let error; try { await invoke(binding, native, operation, { stash: hash }); } catch (caught) { error = caught; }
        assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
        assert.deepEqual(snapshot(native), snapshot(cli));
      }
    });
    await check('apply/pop preserve builtin EOL and ident checkout filters', async () => {
      for (const operation of ['stashApply', 'stashPop']) {
        for (const variant of ['crlf', 'ident']) {
          const root = fixture(path.join(scratch, operation + '-' + variant),
            variant === 'crlf' ? 'a text eol=crlf\n' : 'a ident\n');
          write(root, 'a', variant === 'crlf' ? 'saved\r\n' : '$Id$\nchange\n');
          git(root, ['stash', 'push', '-q', '-u']);
          const hash = git(root, ['rev-parse', 'refs/stash']).stdout;
          const index = git(root, ['write-tree']).stdout;
          const result = await invoke(binding, root, operation, { stash: hash });
          const contents = fs.readFileSync(path.join(root, 'a'), 'utf8');
          if (variant === 'crlf') assert.equal(contents, 'saved\r\n');
          else assert.match(contents, /\$Id: [0-9a-f]+ \$/);
          assert.equal(git(root, ['write-tree']).stdout, index);
          assert.equal(result.conflicts, false);
          assert.equal((await invoke(binding, root, 'stashList')).length, operation === 'stashPop' ? 0 : 1);
        }
      }
    });
    await check('apply/pop retain filtering on merge-generated renamed paths', async () => {
      for (const operation of ['stashApply', 'stashPop']) {
        const root = fixture(path.join(scratch, operation + '-renamed-filter'), 'moved text eol=crlf\n');
        write(root, 'a', 'saved\n');
        git(root, ['stash', 'push', '-q', '-u']);
        const hash = git(root, ['rev-parse', 'refs/stash']).stdout;
        git(root, ['mv', 'a', 'moved']); git(root, ['commit', '-q', '-m', 'rename after stash']);
        git(root, ['checkout', '--', 'moved']);
        const result = await invoke(binding, root, operation, { stash: hash });
        assert.equal(result.conflicts, false);
        assert.equal(fs.readFileSync(path.join(root, 'moved'), 'utf8'), 'saved\r\n');
        assert.equal(fs.existsSync(path.join(root, 'a')), false);
      }
    });
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
      await assert.rejects(() => invoke(binding, root, 'stashApply', { stash: stash.stash }), /冲突|已存在或有本地修改|暂存区/);
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
    await check('apply/pop conflict and untracked-overwrite outcomes match Git', async () => {
      for (const operation of ['stashApply', 'stashPop']) for (const kind of ['tracked-conflict', 'untracked-collision']) {
        const prepare = root => {
          fixture(root);
          if (kind === 'tracked-conflict') write(root, '[literal]', 'saved\n');
          else write(root, 'saved-new', 'saved new\n');
          git(root, ['stash', 'push', '-q', '-u']);
          if (kind === 'tracked-conflict') write(root, '[literal]', 'local\n');
          else write(root, 'saved-new', 'local new\n');
        };
        const cli = path.join(scratch, `${operation}-${kind}-cli`);
        const native = path.join(scratch, `${operation}-${kind}-native`);
        prepare(cli); prepare(native);
        const hash = git(native, ['rev-parse', 'refs/stash']).stdout;
        const expected = git(cli, ['stash', operation === 'stashPop' ? 'pop' : 'apply'], true);
        let error; try { await invoke(binding, native, operation, { stash: hash }); } catch (caught) { error = caught; }
        assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
        assert.deepEqual(snapshot(native), snapshot(cli));
      }
    });
    await check('TSD safety remains before mutation', async () => {
      const root = fixture(path.join(scratch, 'safety'));
      write(root, 'a', '%TSD-Header-###%opaque');
      await assert.rejects(() => invoke(binding, root, 'stashCreate', { scope: 'unstaged' }), /透明加密/);
      assert.deepEqual(await invoke(binding, root, 'stashList'), []);
    });
    await check('core.eol, safecrlf, attributesfile and info attributes match Git', async () => {
      const variants = ['core-eol-crlf', 'core-eol-lf', 'attributesfile', 'info-attributes', 'safecrlf'];
      const prepare = (root, variant, scope) => {
        fixture(root);
        if (variant === 'core-eol-crlf' || variant === 'core-eol-lf') {
          git(root, ['config', 'core.autocrlf', 'false']);
          git(root, ['config', 'core.eol', variant.endsWith('crlf') ? 'crlf' : 'lf']);
          write(root, '.gitattributes', '* -filter\na text\n');
        } else if (variant === 'attributesfile') {
          write(root, '.git/custom-attributes', 'a text eol=crlf\n');
          git(root, ['config', 'core.attributesfile', path.join(root, '.git', 'custom-attributes')]);
        } else if (variant === 'info-attributes') {
          write(root, '.git/info/attributes', 'a text eol=crlf\n');
        }
        write(root, 'a', 'configured base\n'); git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'configured base']);
        if (variant === 'safecrlf') {
          git(root, ['config', 'core.autocrlf', 'true']);
          git(root, ['config', 'core.safecrlf', 'true']);
        }
        write(root, 'a', 'configured dirty\n');
        if (scope === 'staged') git(root, ['add', 'a'], true);
      };
      for (const variant of variants) for (const scope of ['unstaged', 'staged']) {
        const cli = path.join(scratch, `${variant}-${scope}-cli`), native = path.join(scratch, `${variant}-${scope}-native`);
        prepare(cli, variant, scope); prepare(native, variant, scope);
        const expected = git(cli, ['stash', 'push', ...(scope === 'staged' ? ['--staged'] : ['-k', '-u'])], true);
        let error; try { await invoke(binding, native, 'stashCreate', { scope }); } catch (caught) { error = caught; }
        assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
        assert.deepEqual(snapshot(native), snapshot(cli));
      }
    });
    await check('external clean/smudge filters affect create and apply like Git', async () => {
      const prepare = root => {
        fixture(root);
        write(root, '.git/upper.js', "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(b).toString().toUpperCase()));");
        write(root, '.git/lower.js', "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(b).toString().toLowerCase()));");
        git(root, ['config', 'filter.case.clean', 'node .git/upper.js']);
        git(root, ['config', 'filter.case.smudge', 'node .git/lower.js']);
        git(root, ['config', 'filter.case.required', 'true']);
        write(root, '.gitattributes', 'a filter=case\n'); write(root, 'a', 'base lower\n');
        git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'filtered base']);
      };
      for (const scope of ['unstaged', 'staged']) {
        const cli = path.join(scratch, `external-${scope}-cli`), native = path.join(scratch, `external-${scope}-native`);
        prepare(cli); prepare(native);
        write(cli, 'a', 'dirty lower\n'); write(native, 'a', 'dirty lower\n');
        if (scope === 'staged') { git(cli, ['add', 'a']); git(native, ['add', 'a']); }
        const expected = git(cli, ['stash', 'push', ...(scope === 'staged' ? ['--staged'] : ['-k', '-u'])], true);
        let error; try { await invoke(binding, native, 'stashCreate', { scope }); } catch (caught) { error = caught; }
        assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
        assert.deepEqual(snapshot(native), snapshot(cli));
      }
      for (const operation of ['stashApply', 'stashPop']) {
        const cli = path.join(scratch, `external-${operation}-cli`), native = path.join(scratch, `external-${operation}-native`);
        prepare(cli); prepare(native);
        write(cli, 'a', 'saved lower\n'); write(native, 'a', 'saved lower\n');
        git(cli, ['stash', 'push', '-q', '-u']); git(native, ['stash', 'push', '-q', '-u']);
        const hash = git(native, ['rev-parse', 'refs/stash']).stdout;
        const expected = git(cli, ['stash', operation === 'stashPop' ? 'pop' : 'apply'], true);
        let error; try { await invoke(binding, native, operation, { stash: hash }); } catch (caught) { error = caught; }
        assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
        assert.deepEqual(snapshot(native), snapshot(cli));
      }
    });
    await check('filter.process clean/smudge affects stash like Git', async () => {
      const processScript = String.raw`let input=Buffer.alloc(0), group=[], state='hello', request={};
const packet=data=>{const b=Buffer.from(data);process.stdout.write(Buffer.from((b.length+4).toString(16).padStart(4,'0')));process.stdout.write(b)};
const flush=()=>process.stdout.write('0000');
function respond(content){packet('status=success\n');flush();for(let i=0;i<content.length;i+=65000)packet(content.subarray(i,i+65000));flush();packet('status=success\n');flush()}
function done(){if(state==='hello'){packet('git-filter-server\n');packet('version=2\n');flush();state='capabilities'}else if(state==='capabilities'){packet('capability=clean\n');packet('capability=smudge\n');flush();state='request'}else if(state==='request'){request={};for(const value of group){const text=value.toString();if(text.startsWith('command='))request.command=text.slice(8).trim()}state='content'}else{const content=Buffer.concat(group);respond(Buffer.from(request.command==='clean'?content.toString().toUpperCase():content.toString().toLowerCase()));state='request'}group=[]}
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4){const length=parseInt(input.subarray(0,4).toString(),16);if(length===0){input=input.subarray(4);done();continue}if(input.length<length)break;group.push(input.subarray(4,length));input=input.subarray(length)}});`;
      const prepare = root => {
        fixture(root); write(root, '.git/process.js', processScript);
        git(root, ['config', 'filter.proc.process', 'node .git/process.js']);
        git(root, ['config', 'filter.proc.required', 'true']);
        write(root, '.gitattributes', 'a filter=proc\n'); write(root, 'a', 'base lower\n');
        git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'process base']);
        write(root, 'a', 'dirty lower\n');
      };
      const cli = path.join(scratch, 'process-filter-cli'), native = path.join(scratch, 'process-filter-native');
      prepare(cli); prepare(native);
      const expected = git(cli, ['stash', 'push', '-k', '-u'], true);
      let error; try { await invoke(binding, native, 'stashCreate', { scope: 'unstaged' }); } catch (caught) { error = caught; }
      assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
      assert.deepEqual(snapshot(native), snapshot(cli));
    });
    await check('required external filter failure leaves stash state unchanged like Git', async () => {
      const prepare = root => {
        fixture(root);
        write(root, '.git/upper.js', "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(b).toString().toUpperCase()));");
        write(root, '.git/fail.js', 'process.exit(1)');
        git(root, ['config', 'filter.upper.clean', 'node .git/upper.js']);
        git(root, ['config', 'filter.upper.required', 'true']);
        git(root, ['config', 'filter.fail.clean', 'node .git/fail.js']);
        git(root, ['config', 'filter.fail.required', 'true']);
        write(root, '.gitattributes', 'a filter=upper\nb filter=fail\n');
        write(root, 'a', 'dirty lower\n'); write(root, 'b', 'dirty failing\n');
      };
      const cli = path.join(scratch, 'required-filter-cli'), native = path.join(scratch, 'required-filter-native');
      prepare(cli); prepare(native);
      const expected = git(cli, ['stash', 'push', '-k', '-u'], true);
      let error; try { await invoke(binding, native, 'stashCreate', { scope: 'unstaged' }); } catch (caught) { error = caught; }
      assert.equal(Boolean(error), expected.code !== 0, error?.message || expected.stderr);
      assert.deepEqual(snapshot(native), snapshot(cli));
    });
    await check('rename file metadata and untracked third parent', async () => {
      const root = fixture(path.join(scratch, 'metadata'));
      fs.renameSync(path.join(root, 'a'), path.join(root, 'renamed'));
      write(root, 'new', 'untracked\n');
      const stash = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      const files = await invoke(binding, root, 'stashFiles', { revision: stash.stash });
      assert.ok(files.some(file => file.path === 'new' && file.status === 'A'));
      assert.ok(files.some(file => file.path === 'renamed' && file.oldPath === 'a' && file.status === 'R'));
      await invoke(binding, root, 'stashDrop', { stash: stash.stash });
      fs.renameSync(path.join(root, 'a'), path.join(root, 'renamed'));
      git(root, ['add', '-A']);
      const staged = await invoke(binding, root, 'stashCreate', { scope: 'staged' });
      const stagedFiles = await invoke(binding, root, 'stashFiles', { revision: staged.stash });
      assert.ok(stagedFiles.some(file => file.status === 'R' && file.oldPath === 'a' && file.path === 'renamed'));
    });
    await check('stash list and files match Git command output', async () => {
      const root = fixture(path.join(scratch, 'list-files-parity'));
      fs.renameSync(path.join(root, 'a'), path.join(root, 'renamed'));
      write(root, 'b', 'modified\n'); write(root, 'new', 'untracked\n');
      git(root, ['stash', 'push', '-q', '-u']);
      write(root, 'c', 'second\n'); git(root, ['stash', 'push', '-q']);
      const expectedList = git(root, ['stash', 'list', '--format=%H%x00%gd%x00%s%x00']).stdout
        .split('\0').filter(Boolean).reduce((rows, value, index, all) => {
          if (index % 3 === 0) rows.push({ hash: value.trim(), stashRef: all[index + 1].trim(), message: all[index + 2].trim() });
          return rows;
        }, []);
      const actualList = (await invoke(binding, root, 'stashList'))
        .map(entry => ({ hash: entry.hash, stashRef: entry.stashRef, message: entry.message }));
      assert.deepEqual(actualList, expectedList);
      for (const entry of actualList) {
        const expectedFiles = rawStashFiles(root, entry.hash);
        const actualFiles = (await invoke(binding, root, 'stashFiles', { revision: entry.hash }))
          .sort((left, right) => left.path.localeCompare(right.path));
        assert.deepEqual(actualFiles, expectedFiles);
      }
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
    await check('gitlink-only and mixed staged stash/apply match Git', async () => {
      const source = fixture(path.join(scratch, 'child-source'));
      const first = git(source, ['rev-parse', 'HEAD']).stdout;
      git(source, ['commit', '--allow-empty', '-q', '-m', 'child second']);
      const prepare = (root, variant) => {
        fixture(root);
        git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'child']);
        git(root, ['commit', '-q', '-m', 'add child']);
        git(path.join(root, 'child'), ['checkout', '-q', first]);
        git(root, ['add', 'child']);
        if (variant === 'regular-staged') { write(root, 'a', 'regular staged\n'); git(root, ['add', 'a']); }
        if (variant === 'tracked-unstaged' || variant === 'regular-staged') write(root, 'b', 'must remain unstaged\n');
      };
      for (const variant of ['only-gitlink', 'tracked-unstaged', 'regular-staged']) {
        const cli = path.join(scratch, `gitlink-${variant}-cli`);
        const native = path.join(scratch, `gitlink-${variant}-native`);
        prepare(cli, variant); prepare(native, variant);
        const expected = git(cli, ['stash', 'push', '--staged'], true);
        const result = await invoke(binding, native, 'stashCreate', { scope: 'staged' });
        assert.equal(expected.code, 0);
        assert.equal(result.created, git(cli, ['rev-parse', '--verify', 'refs/stash'], true).code === 0);
        assert.deepEqual(snapshot(native), snapshot(cli));
        if (result.created) {
          const applied = git(cli, ['stash', 'apply'], true);
          let error; try { await invoke(binding, native, 'stashApply', { stash: result.stash }); } catch (caught) { error = caught; }
          assert.equal(Boolean(error), applied.code !== 0, error?.message || applied.stderr);
          assert.deepEqual(snapshot(native), snapshot(cli));
        }
      }
    });
    await check('unstaged stash preserves submodule worktree changes', async () => {
      const source = fixture(path.join(scratch, 'dirty-child-source'));
      const root = fixture(path.join(scratch, 'dirty-gitlink-parent'));
      git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'child']);
      git(root, ['commit', '-q', '-m', 'add child']);
      const child = path.join(root, 'child');
      write(child, 'a', 'child edit must stay\n'); write(root, 'a', 'parent edit\n');
      const unstaged = await invoke(binding, root, 'stashCreate', { scope: 'unstaged' });
      assert.ok(unstaged.skippedGitlinks.includes('child'));
      assert.equal(fs.readFileSync(path.join(child, 'a'), 'utf8'), 'child edit must stay\n');
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
