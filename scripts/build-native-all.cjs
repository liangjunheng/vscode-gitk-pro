const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { targets, detectNativeTarget } = require('./native-targets.cjs');
const { prepareNativeBuildEnvironment, toolsRoot } = require('./prepare-native-tools.cjs');
const { prepareDarwinLibgit2Patch } = require('./prepare-libgit2-darwin-patch.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const missingOnly = args.includes('--missing');
const dryRun = args.includes('--dry-run');

function argument(name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const inline = args.find(value => value.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

const availableParallelism = typeof os.availableParallelism === 'function'
  ? os.availableParallelism()
  : os.cpus().length;
const requestedJobs = argument('--jobs') || process.env.VSCODE_GITK_NATIVE_JOBS;
const jobs = requestedJobs
  ? positiveInteger(requestedJobs, '--jobs')
  : Math.min(3, Math.max(1, availableParallelism));

function hasValidModule(target) {
  const directory = path.join(root, 'lib', target.vscodeTarget);
  if (!fs.existsSync(directory)) return false;
  const actual = fs.readdirSync(directory).filter(name => name.endsWith('.node')).sort();
  return actual.length === 1 && target.bindings.some(name => actual.includes(name));
}

function formatCommand(command, commandArgs) {
  return [command, ...commandArgs].map(value => value.includes(' ') ? JSON.stringify(value) : value).join(' ');
}

function run(command, commandArgs, options = {}) {
  const { label: labelName, ...spawnOptions } = options;
  const label = labelName ? `[${labelName}] ` : '';
  console.log(`${label}> ${formatCommand(command, commandArgs)}`);
  if (dryRun) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: 'inherit',
      ...spawnOptions,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${formatCommand(command, commandArgs)} failed with ${reason}`));
    });
  });
}

async function runPool(items, concurrency, task) {
  let nextIndex = 0;
  let firstError;

  async function worker() {
    while (!firstError) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        await task(items[index], index);
      } catch (error) {
        firstError ||= error;
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  ));
  if (firstError) throw firstError;
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
  const defaultCargoTargetDirectory = path.join(toolsRoot(), 'cargo-target');
  const baseCargoTargetDirectory = env.VSCODE_GITK_CARGO_TARGET_DIR || defaultCargoTargetDirectory;
  const effectiveJobs = Math.min(jobs, selected.length);
  const jobsPerTarget = Math.max(1, Math.floor(availableParallelism / effectiveJobs));
  const crossTargets = selected.filter(target => target.vscodeTarget !== currentTarget);
  const darwinPatch = !dryRun && selected.some(target => target.rustTarget.endsWith('-apple-darwin'))
    ? prepareDarwinLibgit2Patch(path.join(root, 'native', 'git2-backend', 'Cargo.toml'), env)
    : undefined;

  console.log(`native: building ${selected.length} target(s) with ${effectiveJobs} parallel job(s)`);
  console.log(`native: Cargo target root ${baseCargoTargetDirectory}`);

  if (crossTargets.length > 0 && !dryRun) {
    const zig = spawnSync(env.CARGO_ZIGBUILD_ZIG_COMMAND || 'zig', ['version'], { cwd: root, env, encoding: 'utf8' });
    if (zig.error || zig.status !== 0) {
      throw new Error('Building universal native modules requires Zig. The automatic tool bootstrap did not produce a working Zig executable.');
    }
    console.log(`zig ${zig.stdout.trim()}`);
  }

  if (crossTargets.length > 0) {
    await run('rustup', ['target', 'add', ...[...new Set(crossTargets.map(target => target.rustTarget))]], { env });
  }

  await runPool(selected, jobs, async target => {
    const startedAt = Date.now();
    const targetDirectory = path.join(baseCargoTargetDirectory, target.vscodeTarget);
    const targetEnv = {
      ...env,
      CARGO_BUILD_JOBS: env.CARGO_BUILD_JOBS || String(jobsPerTarget),
      CARGO_MAKEFLAGS: process.env.VSCODE_GITK_MAKEFLAGS || `-j${jobsPerTarget}`,
      CARGO_TARGET_DIR: targetDirectory,
      MACOSX_DEPLOYMENT_TARGET: env.MACOSX_DEPLOYMENT_TARGET || '10.13',
      VSCODE_GITK_CARGO_TARGET_DIR: targetDirectory,
      ...(darwinPatch ? { VSCODE_GITK_LIBGIT2_PATCH: darwinPatch } : {}),
    };

    console.log(`[${target.vscodeTarget}] starting; target-dir=${targetDirectory}`);
    if (target.vscodeTarget === currentTarget) {
      await run(process.execPath, [
        path.join(__dirname, 'build-native.cjs'),
        '--vscode-target',
        target.vscodeTarget,
      ], { env: targetEnv, label: target.vscodeTarget });
    } else {
      await run(process.execPath, [
        path.join(__dirname, 'build-native-cross.cjs'),
        '--vscode-target',
        target.vscodeTarget,
        '--target',
        target.rustTarget,
      ], { env: targetEnv, label: target.vscodeTarget });
    }
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[${target.vscodeTarget}] completed in ${elapsedSeconds}s`);
  });

  await run(process.execPath, [path.join(__dirname, 'verify-native-platform.cjs'), 'universal'], { env });
})().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
