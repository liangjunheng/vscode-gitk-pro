import * as fs from 'fs';
import * as path from 'path';

interface NativeGitBinding {
    bindingVersion(): string;
    libgit2Version(): string;
    invoke(operation: string, payload: string): Promise<string>;
}

let cachedBinding: NativeGitBinding | undefined;

function nativeCandidates(): string[] {
    const directory = path.resolve(__dirname, '..', '..', 'native');
    const platform = process.platform;
    const arch = process.arch;
    const candidates: string[] = [];
    if (platform === 'win32') {
        candidates.push(`index.win32-${arch}-msvc.node`, `index.win32-${arch}-gnu.node`);
    } else if (platform === 'linux') {
        if (arch === 'arm') {
            // VS Code linux-armhf is ARMv7 hard-float; napi names the ABI explicitly.
            candidates.push('index.linux-arm-gnueabihf.node');
        } else {
            candidates.push(`index.linux-${arch}-gnu.node`, `index.linux-${arch}-musl.node`);
        }
    } else if (platform === 'darwin') {
        candidates.push(`index.darwin-${arch}.node`);
    }
    candidates.push('index.node');
    return candidates.map(fileName => path.join(directory, fileName));
}

export function loadNativeGitBinding(): NativeGitBinding {
    if (cachedBinding) { return cachedBinding; }
    const errors: string[] = [];
    for (const candidate of nativeCandidates()) {
        if (!fs.existsSync(candidate)) { continue; }
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

