const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { targets, detectNativeTarget } = require('./native-targets.cjs');
const { prepareNativeBuildEnvironment } = require('./prepare-native-tools.cjs');

const root = path.resolve(__dirname, '..');
const missingOnly = process.argv.includes('--missing');
const dryRun = process.argv.includes('--dry-run');

function hasValidModule(target) {
  const directory = path.join(root, 'lib', target.vscodeTarget);
  if (!fs.existsSync(directory)) return false;
  const actual = fs.readdirSync(directory).filter(name => name.endsWith('.node')).sort();
  return actual.length === 1 && target.bindings.some(name => actual.includes(name));
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  if (dryRun) return;
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

(async () => {
  const selected = missingOnly ? targets.filter(target => !hasValidModule(target)) : [...targets];
  if (selected.length === 0) {
    console.log('universal: all native modules already exist');
    return;
  }

  let currentTarget;
  try {
    currentTarget = detectNativeTarget();
  } catch {
    currentTarget = undefined;
  }

  const env = dryRun ? { ...process.env } : await prepareNativeBuildEnvironment();
  const crossTargets = selected.filter(target => target.vscodeTarget !== currentTarget);
  if (crossTargets.length > 0 && !dryRun) {
    const zig = spawnSync(env.CARGO_ZIGBUILD_ZIG_COMMAND || 'zig', ['version'], { cwd: root, env, encoding: 'utf8' });
    if (zig.error || zig.status !== 0) {
      throw new Error('Building universal native modules requires Zig. The automatic tool bootstrap did not produce a working Zig executable.');
    }
    console.log(`zig ${zig.stdout.trim()}`);
  }

  if (crossTargets.length > 0) {
    run('rustup', ['target', 'add', ...[...new Set(crossTargets.map(target => target.rustTarget))]], { env });
  }

  for (const target of selected) {
    if (target.vscodeTarget === currentTarget) {
      run(process.execPath, [
        path.join(__dirname, 'build-native.cjs'),
        '--vscode-target',
        target.vscodeTarget,
      ], { env });
      continue;
    }
    run(process.execPath, [
      path.join(__dirname, 'build-native-cross.cjs'),
      '--vscode-target',
      target.vscodeTarget,
      '--target',
      target.rustTarget,
    ], {
      env: {
        ...env,
        MACOSX_DEPLOYMENT_TARGET: env.MACOSX_DEPLOYMENT_TARGET || '10.13',
      },
    });
  }

  run(process.execPath, [path.join(__dirname, 'verify-native-platform.cjs'), 'universal'], { env });
})().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
