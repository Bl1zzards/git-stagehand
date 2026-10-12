# Git Stagehand

A tiny VS Code extension that shows staged and unstaged git file and line change
counts in the status bar at all times.

![Git Stagehand status bar](https://raw.githubusercontent.com/Bl1zzards/git-stagehand/refs/heads/main/img/screenshot-footer.png)

- Two color-coded items: staged in white and unstaged in yellow.
- Each item shows a file count with added and removed line totals.
- Hover for a quick summary.
- Click any item to refresh.

## How it works

Counts are read with `git diff --numstat` (unstaged: index vs working tree) and
`git diff --cached --numstat` (staged: HEAD vs index) across the whole workspace.

Refresh triggers:

- on file save
- on window focus
- when `.git` state files change (`index`, `HEAD`, `ORIG_HEAD`)
- on a polling interval (default 5s) so changes made outside VS Code show up too

## Settings

| Setting                      | Default | Description                                                 |
| ---------------------------- | ------- | ----------------------------------------------------------- |
| `gitStagehand.enabled`       | `true`  | Show the status bar item.                                   |
| `gitStagehand.pollInterval`  | `5000`  | Poll interval in ms. `0` disables polling.                  |
| `gitStagehand.hideWhenClean` | `false` | Hide the item when there are no staged or unstaged changes. |

## Installation

Build the extension and install the `.vsix`:

```bash
npx @vscode/vsce package
code --install-extension git-stagehand-*.vsix
```

Or open the Extensions view, click `...` and choose "Install from VSIX...".

## Development

```bash
npm install
npm run compile
```

Press `F5` to open an Extension Development Host with the status bar visible.

## Credits

The extension icon combines two MIT-licensed icons:

- git icon from [vscode-icons](https://github.com/vscode-icons/vscode-icons)
- hand icon from [Phosphor Icons](https://github.com/phosphor-icons/phosphor-icons)

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the full license texts.
