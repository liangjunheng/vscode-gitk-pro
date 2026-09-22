# libgit2 / Git CLI compatibility tests

Run `npm run test:parity` on a host with Git, Rust, Node and a native toolchain. The Git CLI is **only a fixture and oracle in tests**; the shipped extension calls libgit2. `.github/workflows/native-libgit2.yml` runs the native suite on Windows, macOS and Linux and exercises the compiled Node binding on native runners; cross-compiled binaries have load checks.

`native/git2-backend/src/compat_tests.rs` exercises all dispatch operation families against isolated temporary repositories:

| Operation family | Test scenarios |
| --- | --- |
| discover, configGet, submodules | Repository paths, config, submodule metadata |
| readObjects, resolveRevision | Blob content, commit resolution |
| status, hasChanges | CLI staged/unstaged comparison; ignored, untracked, partial edits, CRLF, deletion, rename, conflicts |
| branches, head, commits, commitFiles, gitlinkPaths, aheadBehind, commitDetails, rangeCommits, repositoryState, changedPaths, gitlinkChanges, pushBranches | CLI revisions/trees/parents/remote refs, multiline messages, submodule links |
| stage, stageAll, unstage, restoreWorktree, restoreAll, trackedPaths, indexChangedPaths, hasConflicts | Single/batch stage and unstage, partial edits, deletion, restore, conflict |
| commit, createBranch, createTag, checkout, reset, merge, cherryPick, revert, rebase | Amend, soft/mixed/hard reset, clean/dirty fast-forward, diverged merge/conflicts, rebase, cherry-pick, revert |
| fetch, push, pull, checkoutBranch | Local bare remotes, fetch, push, protected dirty-worktree pull, clean pull |
| updateSubmodules, restoreSubmodule, indexGitlink | Local submodule creation, update, index gitlink |

`npm run test:binding` additionally drives the built Node N-API bridge and JSON dispatch (`discover`, `status`, `stage`, `commit`, `commitDetails`, invalid-operation error).

**Coverage boundary:** These tests exercise the native operation entry points, *not every possible argument/configuration combination*. They do not prove VS Code/Webview click flows, live SSH/HTTPS credentials and proxies, GPG/SSH signing, every Git hook or external clean/smudge-process filter; these need dedicated environment/integration tests. A successful local run verifies only the current host; the CI matrix result must be checked separately for other platforms.
