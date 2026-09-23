# Repository Switching Sequence

## Design principle: single writer for branches

`branches` is written by exactly three places. `refreshInternal` never touches it.

| Writer | When |
| --- | --- |
| `publishCurrentBranchLoading` | Repository switch fast path, writes the single current branch |
| `refreshBranchesAfterRepositorySelection` | Background full branch list, merges and keeps the selection |
| `refreshSelectors` repository-options-changed branch | After submodule discovery changes the repository option set |

`refreshSelectors` reads `this.branches` but does not return or write it, so a
background refresh that lands mid-flight can never be overwritten by a stale
entry snapshot.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User as User
    participant Webview as Repository selector
    participant Provider as GitkViewProvider
    participant Store as Store
    participant Git as Git log provider
    participant Diff as Changed Files / Diff

    User->>Webview: Select repository
    Webview->>Provider: selectRepositories(paths)
    Provider->>Store: dispatch(intent)

    Store->>Store: Validate paths, skip if unchanged
    Store->>Store: Set selectedRepositoryPaths
    Store->>Store: Clear current hash, repository, and file
    Store-->>Provider: selectRepositories effect

    Provider->>Provider: beginCommitReload()
    Provider->>Provider: Increment commitPageGeneration and searchGeneration
    Provider->>Provider: Abort paging, search, and file requests
    Provider->>Diff: Stop reader and cancel pending render

    Note over Provider,Webview: Repository selection cannot mutate the branch display.<br/>The previous confirmed display remains until onSelectedBranchesChanged.
    Provider->>Webview: branchesLoading

    alt One repository selected
        Provider->>Provider: Create selectRepositoryAbortController

        Provider->>Git: getCurrentGitBranch(rootUri, signal)
        Provider->>Git: getCurrentGitHeadHash(rootUri, signal)
        Git-->>Provider: Branch name and HEAD hash

        alt HEAD resolved
            alt Branch name present
                Provider->>Provider: Current option = refs/heads/&lt;name&gt;
            else Detached HEAD
                Provider->>Provider: Current option = bare hash, label = short hash
            end

            Provider->>Store: Set branches, selected branch, branchesLoading = false
            Provider->>Webview: pushStateToWebview (synchronous)
            Webview-->>User: Current branch visible immediately

            Provider->>Git: getGitBranches(rootUri) in background
            Provider->>Git: getGitCommits(rootUri, current option)
            Git-->>Provider: First commit page
            Provider->>Store: Publish fast-path commit list
            Provider->>Provider: selectCommit(first commit)
            Provider->>Diff: Load changed files and render diff
        else No HEAD (empty repository)
            Provider->>Git: getGitBranches(rootUri) in background
            Note over Provider,Git: Nothing to select; the background refresh<br/>settles the branch selector
        end
    end

    Provider->>Provider: refresh(false, true)
    Provider->>Provider: Increment refreshGeneration and abort prior refresh
    Provider->>Git: refreshSelectors(reloadRepositories = false)
    Git-->>Provider: Repositories and selected branches only

    alt Fast path produced commits and selection is unchanged
        Provider->>Store: Publish repositories only
        Note over Provider,Store: Short circuit: commits are not reloaded
    else Fast path failed or selection changed
        Provider->>Git: getGitCommits(selected branches)
        Git-->>Provider: Refreshed commit page
        Provider->>Store: Publish repositories, selection, and commits
        Provider->>Provider: selectCommit(current or first commit)
        Provider->>Diff: Load changed files and render diff
    end

    Git-->>Provider: Full branch list (background)
    Provider->>Store: Merge full list, keep selection, branchesLoading = false
    Store-->>Webview: stateUpdate
    Webview-->>User: Full branch list, spinner cleared
```

## Why the synchronous push is required

`store.setState` and `store.batch` schedule the push through `queueMicrotask`,
so consecutive updates inside one synchronous block collapse into a single
snapshot. `refreshBranchesAfterRepositorySelection` sets `branchesLoading = true`
in its synchronous prologue, which would otherwise overwrite the
"current branch, not loading" frame before it ever reaches the Webview.
`publishCurrentBranchLoading` therefore calls `pushStateToWebview()` directly.

## Generation guards

| Guard | Protects |
| --- | --- |
| `refreshGeneration` + `refreshAbortController` | A whole refresh round |
| `commitPageGeneration` + `loadMoreAbortController` | Commit paging and prefetch |
| `commitFilesGeneration` + `commitFilesAbortController` | Changed files and diff |
| `searchGeneration` + `searchAbortController` | Search results |
| `selectRepositoryAbortController` | Repository switch fast path, separate so the following refresh does not abort it |
| `branchesRefreshGeneration` + selected path check | Background branch refresh, separate so the following refresh does not discard it |

The two dedicated guards exist because `refresh` aborts its own predecessor and
increments `refreshGeneration`. Anything started fire-and-forget before that call
must not depend on either of them.

## Behaviour per repository state

| State | Branch selector | Commit history | staged / changes rows |
| --- | --- | --- | --- |
| Normal, multiple branches | Current branch immediately, then full list | First page immediately | Yes |
| Detached HEAD | Short hash immediately, then full list | First page immediately | Yes |
| Empty repository (no commits) | Loading, then empty | Empty | No |
