const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toolsRoot } = require('./prepare-native-tools.cjs');
const { STASH_PATCH_REVISION, applyStashPatch, stashPatchFiles } = require('./libgit2-stash-patch.cjs');

const LIBGIT2_SYS_VERSION = '0.18.8+1.9.7';
const PATCH_REVISION = 3;
const STAMP_FILE = '.vscode-gitk-libgit2-patch.json';
const STASH_PATCH_DATA = path.join(__dirname, 'libgit2-stash-performance.patch');

const buildScriptReplacements = Object.freeze([
  Object.freeze([
`        if windows {
            features.push_str("#define GIT_WINHTTP 1\\n");
        } else if target.contains("apple") {
            features.push_str("#define GIT_SECURE_TRANSPORT 1\\n");
        } else {
            features.push_str("#define GIT_OPENSSL 1\\n");
            if let Some(path) = env::var_os("DEP_OPENSSL_INCLUDE") {
                cfg.include(path);
            }
        }`,
`        if windows {
            features.push_str("#define GIT_WINHTTP 1\\n");
        } else {
            features.push_str("#define GIT_OPENSSL 1\\n");
            if let Some(path) = env::var_os("DEP_OPENSSL_INCLUDE") {
                cfg.include(path);
            }
        }`,
  ]),
  Object.freeze([
`        if windows {
            features.push_str("#define GIT_SHA256_WIN32 1\\n");
            cfg.file("libgit2/src/util/hash/win32.c");
        } else if target.contains("apple") {
            features.push_str("#define GIT_SHA256_COMMON_CRYPTO 1\\n");
            cfg.file("libgit2/src/util/hash/common_crypto.c");
        } else {
            features.push_str("#define GIT_SHA256_OPENSSL 1\\n");
            cfg.file("libgit2/src/util/hash/openssl.c");
        }`,
`        if windows {
            features.push_str("#define GIT_SHA256_WIN32 1\\n");
            cfg.file("libgit2/src/util/hash/win32.c");
        } else {
            features.push_str("#define GIT_SHA256_OPENSSL 1\\n");
            cfg.file("libgit2/src/util/hash/openssl.c");
        }`,
  ]),
  Object.freeze([
`    if target.contains("apple") {
        println!("cargo:rustc-link-lib=iconv");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }`,
`    if target.contains("apple") {
        println!("cargo:rustc-link-lib=iconv");
    }`,
  ]),
]);

const bindingsReplacements = Object.freeze([
  Object.freeze([
    'pub const GIT_REBASE_NO_OPERATION: usize = usize::max_value();',
    'pub const GIT_REBASE_NO_OPERATION: usize = usize::MAX;',
  ]),
]);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function buildCacheRoot() {
  // OneDrive/DLP can deny directory renames used for atomic patch publication.
  // Keep generated sources local on Windows; retain explicit tool-root overrides.
  if (process.platform === 'win32' && !process.env.VSCODE_GITK_NATIVE_TOOLS) {
    const local = process.env.LOCALAPPDATA || require('node:os').tmpdir();
    const repositoryKey = crypto.createHash('sha256').update(path.resolve(__dirname, '..')).digest('hex').slice(0, 12);
    return path.join(local, 'vscode-gitk-native-cache', repositoryKey);
  }
  return toolsRoot();
}

function assertInsideTools(candidate) {
  const root = path.resolve(buildCacheRoot());
  const resolved = path.resolve(candidate);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to modify a path outside the native tools directory: ${resolved}`);
  }
  return resolved;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function validPatch(directory, darwin) {
  const stampPath = path.join(directory, STAMP_FILE);
  if (!fs.existsSync(stampPath)) return false;
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    return stamp.version === LIBGIT2_SYS_VERSION
      && stamp.patchRevision === PATCH_REVISION
      && stamp.stashPatchRevision === STASH_PATCH_REVISION
      && stamp.stashPatchImplementationSha256 === sha256(require.resolve('./libgit2-stash-patch.cjs'))
      && stamp.stashPatchDataSha256 === sha256(STASH_PATCH_DATA)
      && stamp.darwin === darwin
      && stamp.buildScriptSha256 === sha256(path.join(directory, 'build.rs'))
      && stamp.bindingsSha256 === sha256(path.join(directory, 'lib.rs'))
      && stashPatchFiles.every(file => stamp.stashFiles?.[file] === sha256(path.join(directory, file)));
  } catch {
    return false;
  }
}

function cargoMetadata(manifest, env) {
  const result = spawnSync('cargo', [
    'metadata',
    '--format-version', '1',
    '--locked',
    '--manifest-path', manifest,
  ], { cwd: path.dirname(manifest), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed:\n${[result.stdout, result.stderr].filter(Boolean).join('\n').trim()}`);
  }
  return JSON.parse(result.stdout);
}

function locateRegistryCrate(manifest, env) {
  const metadata = cargoMetadata(manifest, env);
  const package = metadata.packages.find(candidate => (
    candidate.name === 'libgit2-sys' && candidate.version === LIBGIT2_SYS_VERSION
  ));
  if (!package) {
    throw new Error(`Cargo metadata does not contain libgit2-sys ${LIBGIT2_SYS_VERSION}`);
  }
  if (!String(package.source || '').startsWith('registry+')) {
    throw new Error(`Expected a registry libgit2-sys package, received ${package.source || 'no source'}`);
  }
  return path.dirname(package.manifest_path);
}

function patchFile(file, replacements, label) {
  let contents = fs.readFileSync(file, 'utf8');
  for (const [original, replacement] of replacements) {
    if (!contents.includes(original)) {
      throw new Error(`libgit2-sys ${LIBGIT2_SYS_VERSION} ${label} no longer matches the expected patch context`);
    }
    contents = contents.replace(original, replacement);
  }
  fs.writeFileSync(file, contents);
}

function prepareLibgit2Patch(manifest, env = process.env, darwin = false) {
  const patchRoot = assertInsideTools(path.join(buildCacheRoot(), 'patched-crates'));
  const destination = assertInsideTools(path.join(patchRoot, `libgit2-sys-${LIBGIT2_SYS_VERSION}${darwin ? '' : '-stash'}`));
  if (validPatch(destination, darwin)) return destination;

  fs.mkdirSync(patchRoot, { recursive: true });
  const lockDirectory = assertInsideTools(`${destination}.lock`);
  const deadline = Date.now() + 10 * 60 * 1000;
  let ownsLock = false;
  while (!ownsLock) {
    try {
      fs.mkdirSync(lockDirectory);
      ownsLock = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (validPatch(destination, darwin)) return destination;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockDirectory}`);
      sleep(250);
    }
  }

  const staging = assertInsideTools(`${destination}.tmp-${process.pid}-${Date.now()}`);
  try {
    if (validPatch(destination, darwin)) return destination;
    const source = locateRegistryCrate(path.resolve(manifest), env);
    fs.cpSync(source, staging, { recursive: true });
    const buildScript = path.join(staging, 'build.rs');
    const bindings = path.join(staging, 'lib.rs');
    if (darwin) patchFile(buildScript, buildScriptReplacements, 'build.rs');
    patchFile(bindings, bindingsReplacements, 'lib.rs');
    applyStashPatch(staging);
    fs.writeFileSync(path.join(staging, STAMP_FILE), `${JSON.stringify({
      version: LIBGIT2_SYS_VERSION,
      patchRevision: PATCH_REVISION,
      stashPatchRevision: STASH_PATCH_REVISION,
      stashPatchImplementationSha256: sha256(require.resolve('./libgit2-stash-patch.cjs')),
      stashPatchDataSha256: sha256(STASH_PATCH_DATA),
      darwin,
      stashFiles: Object.fromEntries(stashPatchFiles.map(file => [file, sha256(path.join(staging, file))])),
      buildScriptSha256: sha256(buildScript),
      bindingsSha256: sha256(bindings),
    }, null, 2)}\n`);
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    console.log(`native: prepared libgit2 stash/filter patch at ${destination}`);
    return destination;
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (ownsLock && fs.existsSync(lockDirectory)) fs.rmdirSync(lockDirectory);
  }
}


function prepareDarwinLibgit2Patch(manifest, env = process.env) {
  return prepareLibgit2Patch(manifest, env, true);
}

function prepareDarwinBuildWorkspace(repositoryRoot, vscodeTarget) {
  if (!/^darwin-(x64|arm64)$/.test(vscodeTarget)) {
    throw new Error(`Unexpected Darwin build workspace target: ${vscodeTarget}`);
  }
  return prepareBuildWorkspace(repositoryRoot, vscodeTarget);
}

function prepareBuildWorkspace(repositoryRoot, target) {
  if (!/^[a-z][a-z0-9-]*$/.test(target)) throw new Error(`Invalid build workspace target: ${target}`);
  const workspace = assertInsideTools(path.join(buildCacheRoot(), 'build-workspaces', target));
  if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
  const backend = path.join(workspace, 'git2-backend');
  const napiBuildPatch = path.join(workspace, 'napi-build-patch');
  fs.mkdirSync(backend, { recursive: true });

  const sourceBackend = path.join(repositoryRoot, 'native', 'git2-backend');
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'src', 'examples']) {
    const source = path.join(sourceBackend, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(backend, name), { recursive: true });
  }
  fs.cpSync(path.join(repositoryRoot, 'native', 'napi-build-patch'), napiBuildPatch, { recursive: true });
  return path.join(backend, 'Cargo.toml');
}

function libgit2PatchConfig(directory) {
  const normalized = path.resolve(directory).replaceAll('\\', '/');
  return `patch.crates-io.libgit2-sys.path=${JSON.stringify(normalized)}`;
}

module.exports = {
  LIBGIT2_SYS_VERSION,
  libgit2PatchConfig,
  prepareDarwinBuildWorkspace,
  prepareDarwinLibgit2Patch,
  prepareLibgit2Patch,
  prepareBuildWorkspace,
};
