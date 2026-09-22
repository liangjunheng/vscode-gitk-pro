import * as fs from 'fs';
import * as path from 'path';

interface NativeGitBinding {
    bindingVersion(): string;
    libgit2Version(): string;
    invoke(operation: string, payload: string): Promise<string>;
}

const nativeBindingFiles = {
    'win32-x64': ['index.win32-x64-msvc.node', 'index.win32-x64-gnu.node'],
    'win32-arm64': ['index.win32-arm64-msvc.node', 'index.win32-arm64-gnu.node'],
    'linux-x64': ['index.linux-x64-gnu.node'],
    'linux-arm64': ['index.linux-arm64-gnu.node'],
    'linux-armhf': ['index.linux-arm-gnueabihf.node'],
    'alpine-x64': ['index.linux-x64-musl.node'],
    'alpine-arm64': ['index.linux-arm64-musl.node'],
    'darwin-x64': ['index.darwin-x64.node'],
    'darwin-arm64': ['index.darwin-arm64.node'],
} as const;

type NativeTarget = keyof typeof nativeBindingFiles;

let cachedBinding: NativeGitBinding | undefined;

function nativeTarget(): NativeTarget {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'win32') {
        if (arch === 'x64') { return 'win32-x64'; }
        if (arch === 'arm64') { return 'win32-arm64'; }
    }
    if (platform === 'darwin') {
        if (arch === 'x64') { return 'darwin-x64'; }
        if (arch === 'arm64') { return 'darwin-arm64'; }
    }
    if (platform === 'linux') {
        if (arch === 'arm') { return 'linux-armhf'; }
        if (arch === 'x64' || arch === 'arm64') {
            const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
            const isGlibc = Boolean(report?.header?.glibcVersionRuntime);
            if (arch === 'x64') { return isGlibc ? 'linux-x64' : 'alpine-x64'; }
            return isGlibc ? 'linux-arm64' : 'alpine-arm64';
        }
    }
    throw new Error(`不支持的 libgit2 原生平台：${platform}/${arch}`);
}

function nativeCandidates(): string[] {
    const target = nativeTarget();
    const directory = path.resolve(__dirname, '..', '..', 'lib', target);
    const actual = fs.existsSync(directory)
        ? fs.readdirSync(directory).filter(name => name.endsWith('.node')).sort()
        : [];
    const expected = nativeBindingFiles[target];
    const candidates = actual.filter(name => (expected as readonly string[]).includes(name));
    if (actual.length !== 1 || candidates.length !== 1) {
        throw new Error(
            `扩展包缺少 ${target} 对应的 libgit2 原生模块，请重新安装完整的通用 VSIX。` +
            ` 当前找到：${actual.join(', ') || '无'}`,
        );
    }
    return candidates.map(fileName => path.join(directory, fileName));
}

export function loadNativeGitBinding(): NativeGitBinding {
    if (cachedBinding) { return cachedBinding; }
    const errors: string[] = [];
    for (const candidate of nativeCandidates()) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            cachedBinding = require(candidate) as NativeGitBinding;
            return cachedBinding;
        } catch (error) {
            errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`无法加载 libgit2 原生模块${errors.length > 0 ? `：${errors.join('；')}` : ''}`);
}

export async function invokeNativeGit<T>(operation: string, payload: object): Promise<T> {
    const output = await loadNativeGitBinding().invoke(operation, JSON.stringify(payload));
    return JSON.parse(output) as T;
}

export function getNativeGitVersions(): { binding: string; libgit2: string } {
    const binding = loadNativeGitBinding();
    return { binding: binding.bindingVersion(), libgit2: binding.libgit2Version() };
}
