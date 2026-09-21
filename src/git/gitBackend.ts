import * as vscode from 'vscode';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { WorkingTreeChanges } from '../types';
import {
    getIndexChangedPaths,
    getWorkingTreeStatus,
    getWorkingTreeStatusForPaths,
    hasWorkingTreeChanges,
    runGitCommand,
} from './gitLogProvider';

/** Git 工作区与对象读取边界；后续可在不改 UI/Watcher 的前提下替换为 libgit2 实现。 */
export interface GitBackend extends vscode.Disposable {
    warmup(rootUri: vscode.Uri): Promise<void>;
    readObjects(rootUri: vscode.Uri, objects: readonly string[]): Promise<Map<string, string>>;
    getWorkingTreeStatus(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges>;
    getWorkingTreeStatusForPaths(rootUri: vscode.Uri, paths: readonly string[], signal?: AbortSignal): Promise<WorkingTreeChanges>;
    getIndexChangedPaths(rootUri: vscode.Uri, signal?: AbortSignal): Promise<Set<string>>;
    hasWorkingTreeChanges(rootUri: vscode.Uri, signal?: AbortSignal): Promise<boolean>;
    stage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void>;
    unstage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void>;
    discardWorktree(rootUri: vscode.Uri, paths: readonly string[]): Promise<void>;
}

interface GitObjectRequest {
    readonly objects: readonly string[];
    readonly result: Map<string, string>;
    objectIndex: number;
    resolve(value: Map<string, string>): void;
    reject(error: unknown): void;
}

interface GitObjectSession {
    readonly key: string;
    readonly child: ChildProcessWithoutNullStreams;
    readonly queue: GitObjectRequest[];
    active?: GitObjectRequest;
    buffer: Buffer;
    stderr: string;
    closed: boolean;
}

/** 当前 Git CLI 后端：写操作走 git.exe，对象读取复用每仓库长驻的 cat-file --batch。 */
export class CliGitBackend implements GitBackend {
    private readonly objectSessions = new Map<string, GitObjectSession>();

    async warmup(rootUri: vscode.Uri): Promise<void> {
        await this.readObjects(rootUri, ['HEAD^{tree}']);
    }

    readObjects(rootUri: vscode.Uri, objects: readonly string[]): Promise<Map<string, string>> {
        if (objects.length === 0) { return Promise.resolve(new Map()); }
        const uniqueObjects = [...new Set(objects)];
        const session = this.getObjectSession(rootUri);
        return new Promise((resolve, reject) => {
            session.queue.push({ objects: uniqueObjects, result: new Map(), objectIndex: 0, resolve, reject });
            this.pumpObjectSession(session);
        });
    }

    getWorkingTreeStatus(rootUri: vscode.Uri, signal?: AbortSignal): Promise<WorkingTreeChanges> {
        return getWorkingTreeStatus(rootUri, signal);
    }

    getWorkingTreeStatusForPaths(rootUri: vscode.Uri, paths: readonly string[], signal?: AbortSignal): Promise<WorkingTreeChanges> {
        return getWorkingTreeStatusForPaths(rootUri, paths, signal);
    }

    getIndexChangedPaths(rootUri: vscode.Uri, signal?: AbortSignal): Promise<Set<string>> {
        return getIndexChangedPaths(rootUri, signal);
    }

    hasWorkingTreeChanges(rootUri: vscode.Uri, signal?: AbortSignal): Promise<boolean> {
        return hasWorkingTreeChanges(rootUri, signal);
    }

    async stage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void> {
        if (paths.length > 0) { await runGitCommand(rootUri, ['add', '--', ...paths]); }
    }

    async unstage(rootUri: vscode.Uri, paths: readonly string[]): Promise<void> {
        if (paths.length > 0) { await runGitCommand(rootUri, ['restore', '--staged', '--', ...paths]); }
    }

    async discardWorktree(rootUri: vscode.Uri, paths: readonly string[]): Promise<void> {
        if (paths.length > 0) { await runGitCommand(rootUri, ['restore', '--worktree', '--', ...paths]); }
    }

    dispose(): void {
        for (const session of this.objectSessions.values()) {
            this.closeObjectSession(session);
        }
        this.objectSessions.clear();
    }

    private getObjectSession(rootUri: vscode.Uri): GitObjectSession {
        const key = process.platform === 'win32' ? rootUri.fsPath.toLowerCase() : rootUri.fsPath;
        const existing = this.objectSessions.get(key);
        if (existing && !existing.closed) { return existing; }
        const child = spawn(
            'git',
            ['--no-optional-locks', '-C', rootUri.fsPath, 'cat-file', '--batch'],
            { windowsHide: true },
        );
        const session: GitObjectSession = {
            key,
            child,
            queue: [],
            buffer: Buffer.alloc(0),
            stderr: '',
            closed: false,
        };
        this.objectSessions.set(key, session);
        child.stdout.on('data', (chunk: Buffer) => {
            session.buffer = session.buffer.length === 0 ? chunk : Buffer.concat([session.buffer, chunk]);
            try { this.parseObjectSession(session); } catch (error) { this.failObjectSession(session, error); }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            session.stderr = `${session.stderr}${chunk.toString()}`.slice(-8192);
        });
        child.on('error', error => this.failObjectSession(session, error));
        child.on('close', code => {
            if (session.closed) { return; }
            if (code === 0 && !session.active && session.queue.length === 0) {
                session.closed = true;
                this.objectSessions.delete(session.key);
                return;
            }
            this.failObjectSession(session, new Error(session.stderr || `git cat-file 失败（退出码 ${code}）`));
        });
        return session;
    }

    private pumpObjectSession(session: GitObjectSession): void {
        if (session.closed || session.active || session.queue.length === 0) { return; }
        session.active = session.queue.shift();
        session.stderr = '';
        const payload = `${session.active!.objects.join('\n')}\n`;
        session.child.stdin.write(payload, error => {
            if (error) { this.failObjectSession(session, error); }
        });
    }

    private parseObjectSession(session: GitObjectSession): void {
        const request = session.active;
        if (!request) { return; }
        while (request.objectIndex < request.objects.length) {
            const headerEnd = session.buffer.indexOf(0x0A);
            if (headerEnd < 0) { return; }
            const header = session.buffer.subarray(0, headerEnd).toString('utf8');
            const size = Number(header.split(' ')[2]);
            if (!Number.isFinite(size)) {
                session.buffer = session.buffer.subarray(headerEnd + 1);
                request.objectIndex++;
                continue;
            }
            const contentStart = headerEnd + 1;
            const responseEnd = contentStart + size + 1;
            if (session.buffer.length < responseEnd) { return; }
            request.result.set(
                request.objects[request.objectIndex],
                session.buffer.subarray(contentStart, contentStart + size).toString('utf8'),
            );
            session.buffer = session.buffer.subarray(responseEnd);
            request.objectIndex++;
        }
        session.active = undefined;
        request.resolve(request.result);
        this.pumpObjectSession(session);
    }

    private failObjectSession(session: GitObjectSession, error: unknown): void {
        if (session.closed) { return; }
        session.closed = true;
        if (this.objectSessions.get(session.key) === session) { this.objectSessions.delete(session.key); }
        session.active?.reject(error);
        session.active = undefined;
        session.queue.splice(0).forEach(request => request.reject(error));
        try { session.child.kill(); } catch { /* 已退出 */ }
    }

    private closeObjectSession(session: GitObjectSession): void {
        if (session.closed) { return; }
        session.closed = true;
        if (this.objectSessions.get(session.key) === session) { this.objectSessions.delete(session.key); }
        const error = new Error('git cat-file 会话已关闭');
        session.active?.reject(error);
        session.queue.splice(0).forEach(request => request.reject(error));
        try { session.child.stdin.end(); } catch { /* 已退出 */ }
        try { session.child.kill(); } catch { /* 已退出 */ }
    }
}
