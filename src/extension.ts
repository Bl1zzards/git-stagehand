import { execFile } from 'child_process';
import * as vscode from 'vscode';

interface Counts {
    files: number;
    additions: number;
    deletions: number;
}

interface RepoCounts {
    name: string;
    staged: Counts;
    unstaged: Counts;
}

const EMPTY: Counts = { files: 0, additions: 0, deletions: 0 };

let stagedItem: vscode.StatusBarItem;
let unstagedItem: vscode.StatusBarItem;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let refreshToken = 0;
let refreshing = false;

function run(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd, maxBuffer: 1 << 24 }, (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(stdout.toString());
        });
    });
}

/**
 * Checks if the given folder is a Git repository.
 */
function isGitRepo(folder: string): Promise<boolean> {
    return run('git', ['rev-parse', '--is-inside-work-tree'], folder)
        .then((out) => out.trim() === 'true')
        .catch(() => false);
}

/**
 * Parses the output of `git diff --numstat` into a `Counts` object.
 */
function parseNumstat(stdout: string): Counts {
    const counts: Counts = { files: 0, additions: 0, deletions: 0 };
    for (const line of stdout.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        const parts = line.split('\t');
        if (parts.length < 3) {
            continue;
        }
        const additions = Number.parseInt(parts[0], 10);
        const deletions = Number.parseInt(parts[1], 10);
        counts.files += 1;
        if (!Number.isNaN(additions)) {
            counts.additions += additions;
        }
        if (!Number.isNaN(deletions)) {
            counts.deletions += deletions;
        }
    }
    return counts;
}

/** 
 * Collects the Git status counts for the given workspace folder.
 * Returns `undefined` if the folder is not a Git repository.
 */
async function collectRepo(folder: vscode.WorkspaceFolder): Promise<RepoCounts | undefined> {
    if (!(await isGitRepo(folder.uri.fsPath))) {
        return undefined;
    }

    const [stagedOut, unstagedOut] = await Promise.all([
        run('git', ['diff', '--cached', '--numstat'], folder.uri.fsPath).catch(() => ''),
        run('git', ['diff', '--numstat'], folder.uri.fsPath).catch(() => '')
    ]);

    return {
        name: folder.name,
        staged: parseNumstat(stagedOut),
        unstaged: parseNumstat(unstagedOut)
    };
}

/**
 * Sums a list of `Counts` objects into a single `Counts` object.
 */
function sum(list: Counts[]): Counts {
    return list.reduce(
        (acc, c) => ({
            files: acc.files + c.files,
            additions: acc.additions + c.additions,
            deletions: acc.deletions + c.deletions
        }),
        { ...EMPTY }
    );
}

/** 
 * Returns the pluralized form of a word based on the given count.
 */
function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Returns a summary string for the given `Counts` object.
 */
function summary(c: Counts): string {
    return `${plural(c.files, 'file')}, +${c.additions}/-${c.deletions}`;
}

/** 
 * Builds the tooltip content for the status bar item.
 */
function buildTooltip(staged: Counts, unstaged: Counts, repos: RepoCounts[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**Git Stagehand**\n\n');
    md.appendMarkdown(`Staged: ${summary(staged)}\n\n`);
    md.appendMarkdown(`Unstaged: ${summary(unstaged)}\n\n`);
    if (repos.length > 1) {
        md.appendMarkdown('---\n\n');
        for (const repo of repos) {
            md.appendMarkdown(`**${repo.name}**\n\n`);
            md.appendMarkdown(`- Staged: ${summary(repo.staged)}\n`);
            md.appendMarkdown(`- Unstaged: ${summary(repo.unstaged)}\n\n`);
        }
    }
    md.appendMarkdown('Click to refresh.');
    return md;
}

/**
 * Displays a single message (e.g. "no repo") and hides the count items.
 */
function showMessage(text: string, tooltip: vscode.MarkdownString): void {
    stagedItem.text = text;
    stagedItem.tooltip = tooltip;
    stagedItem.show();
    unstagedItem.hide();
}

/**
 * Updates both status bar items with the staged and unstaged counts.
 */
function showCounts(staged: Counts, unstaged: Counts, tooltip: vscode.MarkdownString): void {
    stagedItem.text = `$(git-commit) $(files)${staged.files} $(diff-added)${staged.additions} $(diff-removed)${staged.deletions}`;
    stagedItem.tooltip = tooltip;
    stagedItem.show();

    unstagedItem.text = `$(diff-modified) $(files)${unstaged.files} $(diff-added)${unstaged.additions} $(diff-removed)${unstaged.deletions}`;
    unstagedItem.tooltip = tooltip;
    unstagedItem.show();
}

/**
 * Refreshes the Git status for all workspace folders and updates the status bar item.
 */
async function refresh(): Promise<void> {
    if (refreshing) {
        return;
    }
    refreshing = true;
    const token = ++refreshToken;
    try {
        const config = vscode.workspace.getConfiguration('gitStagehand');
        if (!config.get<boolean>('enabled', true)) {
            stagedItem.hide();
            unstagedItem.hide();
            return;
        }

        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
            showMessage('$(git-branch) No folder', new vscode.MarkdownString('Open a folder to see git changes.'));
            return;
        }

        const repos = (await Promise.all(folders.map(collectRepo))).filter(
            (r): r is RepoCounts => r !== undefined
        );

        if (token !== refreshToken) {
            return;
        }

        if (repos.length === 0) {
            showMessage('$(git-branch) No Git repo', new vscode.MarkdownString('No Git repository in this workspace.'));
            return;
        }

        const staged = sum(repos.map((r) => r.staged));
        const unstaged = sum(repos.map((r) => r.unstaged));

        if (config.get<boolean>('hideWhenClean', false) && staged.files === 0 && unstaged.files === 0) {
            stagedItem.hide();
            unstagedItem.hide();
            return;
        }

        showCounts(staged, unstaged, buildTooltip(staged, unstaged, repos));
    } finally {
        refreshing = false;
    }
}

/** 
 * Schedules a refresh of the Git status after a specified delay.
 * @param delay The delay in milliseconds before the refresh is triggered. Defaults to 250ms.
 */
function scheduleRefresh(delay = 250): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => void refresh(), delay);
}

/**
 * Restarts the polling mechanism for refreshing the Git status based on the configured interval.
 */
function restartPolling(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
    }
    const interval = vscode.workspace.getConfiguration('gitStagehand').get<number>('pollInterval', 5000);
    if (interval > 0) {
        pollTimer = setInterval(() => void refresh(), interval);
    }
}

/**
 * Activates the Git Stagehand extension, setting up the status bar item, commands, and event listeners.
 */
export function activate(context: vscode.ExtensionContext): void {
    stagedItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    stagedItem.name = 'Git Stagehand (staged)';
    stagedItem.command = 'gitStagehand.refresh';
    stagedItem.color = new vscode.ThemeColor('terminal.ansiWhite');
    stagedItem.text = '$(git-branch) Git…';
    stagedItem.show();

    unstagedItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    unstagedItem.name = 'Git Stagehand (unstaged)';
    unstagedItem.command = 'gitStagehand.refresh';
    unstagedItem.color = new vscode.ThemeColor('terminal.ansiYellow');

    context.subscriptions.push(stagedItem, unstagedItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('gitStagehand.refresh', () => refresh())
    );

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh()));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh(0)));
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                scheduleRefresh(0);
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gitStagehand')) {
                restartPolling();
                scheduleRefresh(0);
            }
        })
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/.git/{index,HEAD,ORIG_HEAD}');
    watcher.onDidChange(() => scheduleRefresh());
    watcher.onDidCreate(() => scheduleRefresh());
    watcher.onDidDelete(() => scheduleRefresh());
    context.subscriptions.push(watcher);

    restartPolling();
    void refresh();
}

/**
 * Deactivates the Git Stagehand extension, clearing any active timers.
 */
export function deactivate(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
    }
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
}
