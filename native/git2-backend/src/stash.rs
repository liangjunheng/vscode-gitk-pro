//! 纯 libgit2 实现的 stash 创建、读取、应用与删除。
//!
//! stashCreate 的 scope:
//! - unstaged: KEEP_INDEX | INCLUDE_UNTRACKED。
//! - staged:   手工构建标准双父 Stash commit，再用反向 staged diff 更新 index/worktree。
//!
//! Apply/Pop/Drop 全部通过 libgit2；应用前执行安全预检，避免 libgit2 在冲突时留下半应用工作区。
use crate::filters::{
    clean_worktree_for_stash, ensure_stashable, ensure_stashable_with_flags,
    restore_worktree_backups, smudge_worktree_paths, stash_filter_flags,
    stash_path_needs_builtin_filter, stash_path_uses_default_attributes,
    stash_path_uses_external_filter,
};
use crate::history::{delta_value, iso_time, signature_text};
use crate::support::{
    NativeResult, format_git_error, open_repository, repository_root, string_arg, string_array,
};
use git2::{
    ApplyLocation, Binding, Commit, Delta, DiffFindOptions, DiffOptions, ErrorClass, ErrorCode,
    FileMode, IndexEntryExtendedFlag, ObjectType, Oid, Patch, Repository, StashApplyOptions,
    StashFlags, Status, StatusOptions, TreeWalkMode, TreeWalkResult,
    build::{CheckoutBuilder, TreeUpdateBuilder},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString, c_char, c_void};
use std::path::{Path, PathBuf};

const GITLINK_MODE: u32 = 0o160000;
const NO_COMMIT: &str = "仓库还没有任何提交，无法 stash";
const NO_IDENTITY: &str = "无法确定提交者身份，请先配置 user.name 和 user.email";
const UNSTAGED_ONLY_INDEX_PREFIX: &str = "unstaged-only index on ";

fn is_unstaged_only_stash(stash: &Commit<'_>) -> bool {
    stash.parent(1).ok().is_some_and(|index_parent| {
        index_parent
            .message_bytes()
            .starts_with(UNSTAGED_ONLY_INDEX_PREFIX.as_bytes())
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Unstaged,
    Staged,
}

fn parse_scope(payload: &Value) -> NativeResult<Scope> {
    match payload.get("scope").and_then(Value::as_str) {
        Some("unstaged") => Ok(Scope::Unstaged),
        Some("staged") => Ok(Scope::Staged),
        other => Err(format!(
            "不支持的 stash 范围: {}",
            other.unwrap_or("<缺失>")
        )),
    }
}

fn parse_paths(payload: &Value) -> NativeResult<Option<BTreeSet<String>>> {
    let Some(value) = payload.get("paths") else {
        return Ok(None);
    };
    let Some(values) = value.as_array() else {
        return Err("stash paths 必须是字符串数组".to_owned());
    };
    let mut paths = BTreeSet::new();
    for value in values {
        let Some(path) = value.as_str() else {
            return Err("stash paths 必须是字符串数组".to_owned());
        };
        if path.is_empty() {
            return Err("stash paths 不能包含空路径".to_owned());
        }
        paths.insert(normalize(path));
    }
    Ok(Some(paths))
}

fn merge_staged_into_unstaged_arg(payload: &Value) -> NativeResult<bool> {
    match payload.get("mergeStagedIntoUnstaged") {
        None => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "mergeStagedIntoUnstaged 必须是布尔值".to_owned()),
    }
}

fn all_unstaged_paths_arg(payload: &Value) -> NativeResult<bool> {
    match payload.get("allUnstagedPaths") {
        None => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "allUnstagedPaths 必须是布尔值".to_owned()),
    }
}

#[derive(Default, Clone)]
struct Changes {
    staged: Vec<String>,
    staged_gitlinks: Vec<String>,
    unstaged: Vec<String>,
    unstaged_gitlinks: Vec<String>,
}

fn normalize(path: &str) -> String {
    path.replace('\\', "/")
}

fn is_worktree_change(status: Status) -> bool {
    status.intersects(
        Status::WT_NEW
            | Status::WT_MODIFIED
            | Status::WT_DELETED
            | Status::WT_TYPECHANGE
            | Status::WT_RENAMED,
    )
}

fn is_gitlink(index: &git2::Index, head_tree: &git2::Tree<'_>, path: &str) -> bool {
    index
        .get_path(Path::new(path), 0)
        .is_some_and(|entry| entry.mode == GITLINK_MODE)
        || head_tree
            .get_path(Path::new(path))
            .is_ok_and(|entry| entry.filemode_raw() as u32 == GITLINK_MODE)
}

fn collect_changes(repo: &Repository, include_unstaged: bool) -> NativeResult<Changes> {
    let head_tree = repo
        .head()
        .map_err(|_| NO_COMMIT.to_owned())?
        .peel_to_tree()
        .map_err(format_git_error)?;
    let index = repo.index().map_err(format_git_error)?;
    let mut changes = Changes::default();

    // 不做重命名检测：重命名会同时出现旧路径（删除）和新路径（新增），两边都要进入路径集合。
    let diff = repo
        .diff_tree_to_index(Some(&head_tree), Some(&index), None)
        .map_err(format_git_error)?;
    let mut staged = BTreeSet::new();
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(path) = file.path() {
                staged.insert(normalize(&path.to_string_lossy()));
            }
        }
    }
    for path in staged {
        if is_gitlink(&index, &head_tree, &path) {
            changes.staged_gitlinks.push(path);
        } else {
            changes.staged.push(path);
        }
    }

    if include_unstaged {
        let mut options = StatusOptions::new();
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false)
            .exclude_submodules(false);
        let statuses = repo
            .statuses(Some(&mut options))
            .map_err(format_git_error)?;
        let mut unstaged = BTreeSet::new();
        for entry in statuses.iter() {
            if is_worktree_change(entry.status()) {
                unstaged.insert(normalize(&String::from_utf8_lossy(entry.path_bytes())));
            }
        }
        for path in unstaged {
            if is_gitlink(&index, &head_tree, &path) {
                changes.unstaged_gitlinks.push(path);
            } else {
                changes.unstaged.push(path);
            }
        }
    }
    Ok(changes)
}

fn related_staged_paths(
    repo: &Repository,
    selected: &BTreeSet<String>,
) -> NativeResult<Vec<String>> {
    if selected.is_empty() {
        return Ok(Vec::new());
    }
    let head_tree = repo
        .head()
        .map_err(|_| NO_COMMIT.to_owned())?
        .peel_to_tree()
        .map_err(format_git_error)?;
    let index = repo.index().map_err(format_git_error)?;
    let mut options = DiffOptions::new();
    options.include_typechange(true);
    let mut diff = repo
        .diff_tree_to_index(Some(&head_tree), Some(&index), Some(&mut options))
        .map_err(format_git_error)?;
    let mut find = DiffFindOptions::new();
    find.renames(true).renames_from_rewrites(true);
    let _ = diff.find_similar(Some(&mut find));
    let mut paths = BTreeSet::new();
    for delta in diff.deltas() {
        let candidates = [delta.old_file().path(), delta.new_file().path()]
            .into_iter()
            .flatten()
            .map(|path| normalize(&path.to_string_lossy()))
            .collect::<Vec<_>>();
        if candidates.iter().any(|path| selected.contains(path)) {
            paths.extend(candidates);
        }
    }
    Ok(paths.into_iter().collect())
}

fn remove_added_file(root: &Path, relative: &str) -> NativeResult<()> {
    let full = root.join(relative);
    match std::fs::remove_file(&full) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("删除 {} 失败: {error}", full.display())),
    }
    let mut directory = full.parent().map(Path::to_path_buf);
    while let Some(current) = directory {
        if current == root || std::fs::remove_dir(&current).is_err() {
            break;
        }
        directory = current.parent().map(Path::to_path_buf);
    }
    Ok(())
}

fn remove_worktree_path(root: &Path, relative: &str) -> NativeResult<()> {
    let full = root.join(relative);
    let metadata = match std::fs::symlink_metadata(&full) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 {} 失败: {error}", full.display())),
    };
    if metadata.is_dir() {
        std::fs::remove_dir_all(&full)
            .map_err(|error| format!("删除 {} 失败: {error}", full.display()))?;
    } else {
        std::fs::remove_file(&full)
            .map_err(|error| format!("删除 {} 失败: {error}", full.display()))?;
    }
    Ok(())
}

fn backup_worktree_files(
    root: &Path,
    relative: &Path,
    backups: &mut Vec<(PathBuf, Vec<u8>)>,
) -> NativeResult<()> {
    let full = root.join(relative);
    let metadata = match std::fs::symlink_metadata(&full) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 {} 失败: {error}", full.display())),
    };
    if metadata.is_dir() {
        for entry in std::fs::read_dir(&full)
            .map_err(|error| format!("读取 {} 失败: {error}", full.display()))?
        {
            let entry = entry.map_err(|error| format!("读取 {} 失败: {error}", full.display()))?;
            let child = relative.join(entry.file_name());
            backup_worktree_files(root, &child, backups)?;
        }
    } else {
        let contents = std::fs::read(&full)
            .map_err(|error| format!("读取 {} 失败: {error}", full.display()))?;
        backups.push((full, contents));
    }
    Ok(())
}

struct UnstagedIsolation {
    paths: Vec<String>,
    backups: Vec<(PathBuf, Vec<u8>)>,
}

fn isolate_unselected_unstaged(
    repo: &Repository,
    all_paths: &[String],
    selected_paths: &BTreeSet<String>,
) -> NativeResult<Option<UnstagedIsolation>> {
    let paths = all_paths
        .iter()
        .filter(|path| !selected_paths.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return Ok(None);
    }
    let root = repository_root(repo)?;
    let mut backups = Vec::new();
    for path in &paths {
        backup_worktree_files(&root, Path::new(path), &mut backups)?;
    }

    let index = repo.index().map_err(format_git_error)?;
    let head_tree = repo
        .head()
        .map_err(|_| NO_COMMIT.to_owned())?
        .peel_to_tree()
        .map_err(format_git_error)?;
    let tracked = paths
        .iter()
        .filter(|path| {
            index.get_path(Path::new(path), 0).is_some()
                || head_tree.get_path(Path::new(path)).is_ok()
        })
        .cloned()
        .collect::<Vec<_>>();
    let untracked = paths
        .iter()
        .filter(|path| !tracked.contains(path))
        .cloned()
        .collect::<Vec<_>>();
    let result = (|| {
        restore_worktree_paths(repo, &tracked, false, false)?;
        for path in &untracked {
            remove_worktree_path(&root, path)?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let _ = restore_unstaged_isolation(
            &root,
            &UnstagedIsolation {
                paths: paths.clone(),
                backups,
            },
        );
        return Err(error);
    }
    Ok(Some(UnstagedIsolation { paths, backups }))
}

fn restore_unstaged_isolation(root: &Path, isolation: &UnstagedIsolation) -> NativeResult<()> {
    let mut paths = isolation.paths.clone();
    paths.sort_by_key(|path| std::cmp::Reverse(path.len()));
    for path in &paths {
        remove_worktree_path(root, path)?;
    }
    for (path, contents) in &isolation.backups {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建 {} 失败: {error}", parent.display()))?;
        }
        std::fs::write(path, contents)
            .map_err(|error| format!("还原 {} 失败: {error}", path.display()))?;
    }
    Ok(())
}

fn restore_worktree_paths(
    repo: &Repository,
    paths: &[String],
    disable_filters: bool,
    default_attributes: bool,
) -> NativeResult<()> {
    // An empty checkout pathspec means the entire repository, not no files.
    if paths.is_empty() {
        return Ok(());
    }
    let source = repo.index().map_err(format_git_error)?;
    let mut sparse = git2::Index::new().map_err(format_git_error)?;
    for path in paths {
        if let Some(entry) = source.get_path(Path::new(path), 0) {
            sparse.add(&entry).map_err(format_git_error)?;
        }
    }
    let mut checkout = CheckoutBuilder::new();
    checkout
        .force()
        .recreate_missing(true)
        .update_index(false)
        .disable_pathspec_match(true)
        .disable_filters(disable_filters);
    for path in paths {
        checkout.path(path);
    }
    // ensure_stashable rejects external filters before the stash is created.
    // Checkout already applies the built-in EOL/ident filters; do not read and
    // rewrite every blob a second time through the shared smudge helper.
    if default_attributes {
        let encoded = paths
            .iter()
            .map(|path| {
                CString::new(path.as_bytes())
                    .map_err(|_| format!("路径包含无效的 NUL 字符: {path}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let pointers = encoded.iter().map(|path| path.as_ptr()).collect::<Vec<_>>();
        let result = unsafe {
            git_stash_checkout_index_default_attributes(
                repo.raw().cast(),
                sparse.raw().cast(),
                pointers.len(),
                pointers.as_ptr(),
            )
        };
        if result < 0 {
            return Err(format_git_error(git2::Error::last_error(result)));
        }
        Ok(())
    } else {
        repo.checkout_index(Some(&mut sparse), Some(&mut checkout))
            .map_err(format_git_error)
    }
}

fn restore_staged_paths(
    repo: &Repository,
    paths: &[String],
    filtered_paths: &BTreeSet<String>,
    default_attributes: bool,
) -> NativeResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let head = repo.revparse_single("HEAD").map_err(format_git_error)?;
    let head_tree = head.peel_to_tree().map_err(format_git_error)?;
    repo.reset_default(Some(&head), paths.iter().map(String::as_str))
        .map_err(format_git_error)?;
    let (existing, added): (Vec<String>, Vec<String>) = paths
        .iter()
        .cloned()
        .partition(|path| head_tree.get_path(Path::new(path)).is_ok());
    // Restoring attributes can change the filters required by every sibling.
    // In that case keep checkout's full filter handling and its original order.
    if paths.iter().any(|path| {
        Path::new(path).file_name().is_some_and(|name| {
            name.to_string_lossy()
                .eq_ignore_ascii_case(".gitattributes")
        })
    }) {
        restore_worktree_paths(repo, &existing, false, false)?;
    } else if default_attributes {
        restore_worktree_paths(repo, &existing, false, true)?;
    } else {
        let (filtered, unfiltered): (Vec<_>, Vec<_>) = existing
            .into_iter()
            .partition(|path| filtered_paths.contains(path));
        restore_worktree_paths(repo, &unfiltered, true, false)?;
        restore_worktree_paths(repo, &filtered, false, false)?;
    }
    let root = repository_root(repo)?;
    for path in &added {
        remove_added_file(&root, path)?;
    }
    Ok(())
}

fn reset_staged_gitlinks(repo: &Repository, paths: &[String]) -> NativeResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let head = repo.revparse_single("HEAD").map_err(format_git_error)?;
    repo.reset_default(Some(&head), paths.iter().map(String::as_str))
        .map_err(format_git_error)
}

fn stash_error(error: git2::Error) -> String {
    if error.code() == ErrorCode::NotFound && error.class() == ErrorClass::Stash {
        "没有可 stash 的修改（子模块内部的修改不会被 stash）".to_owned()
    } else {
        format_git_error(error)
    }
}

fn staged_tree_oid(
    repo: &Repository,
    base_tree: &git2::Tree<'_>,
    index: &mut git2::Index,
    paths: &[String],
) -> NativeResult<Oid> {
    let mut updates = TreeUpdateBuilder::new();
    for path in paths {
        if let Some(entry) = index.get_path(Path::new(path), 0) {
            let mode = match entry.mode {
                0o100644 => FileMode::Blob,
                0o100664 => FileMode::BlobGroupWritable,
                0o100755 => FileMode::BlobExecutable,
                0o120000 => FileMode::Link,
                0o160000 => FileMode::Commit,
                _ => return index.write_tree_to(repo).map_err(format_git_error),
            };
            updates.upsert(path, entry.id, mode);
        } else {
            updates.remove(path);
        }
    }
    updates
        .create_updated(repo, base_tree)
        .or_else(|_| index.write_tree_to(repo))
        .map_err(format_git_error)
}

fn hunk_ranges(
    diff: &git2::Diff<'_>,
    use_new_side: bool,
) -> NativeResult<BTreeMap<String, Vec<(u32, u32)>>> {
    let mut ranges = BTreeMap::<String, Vec<(u32, u32)>>::new();
    for (index, delta) in diff.deltas().enumerate() {
        let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) else {
            continue;
        };
        let Some(patch) = Patch::from_diff(diff, index).map_err(format_git_error)? else {
            continue;
        };
        for hunk_index in 0..patch.num_hunks() {
            let (hunk, _) = patch.hunk(hunk_index).map_err(format_git_error)?;
            let (start, lines) = if use_new_side {
                (hunk.new_start(), hunk.new_lines())
            } else {
                (hunk.old_start(), hunk.old_lines())
            };
            let end = start.saturating_add(lines.max(1) - 1);
            ranges
                .entry(normalize(&path.to_string_lossy()))
                .or_default()
                .push((start, end));
        }
    }
    Ok(ranges)
}

fn staged_hunks_overlap_worktree(
    repo: &Repository,
    staged: &git2::Diff<'_>,
    index: &git2::Index,
    paths: &[String],
) -> NativeResult<bool> {
    let mut options = DiffOptions::new();
    options
        .include_typechange(true)
        .disable_pathspec_match(true);
    for path in paths {
        options.pathspec(path);
    }
    let worktree = repo
        .diff_index_to_workdir(Some(index), Some(&mut options))
        .map_err(format_git_error)?;
    let staged_ranges = hunk_ranges(staged, true)?;
    let worktree_ranges = hunk_ranges(&worktree, false)?;
    Ok(staged_ranges.iter().any(|(path, staged)| {
        worktree_ranges.get(path).is_some_and(|unstaged| {
            staged.iter().any(|(staged_start, staged_end)| {
                unstaged.iter().any(|(unstaged_start, unstaged_end)| {
                    staged_start.saturating_sub(3) <= unstaged_end.saturating_add(3)
                        && unstaged_start.saturating_sub(3) <= staged_end.saturating_add(3)
                })
            })
        })
    }))
}

fn create_staged_stash(
    repo: &Repository,
    signature: &git2::Signature<'_>,
    changes: &Changes,
    filtered_paths: &BTreeSet<String>,
    default_attributes: bool,
) -> NativeResult<Oid> {
    let head = repo.head().map_err(format_git_error)?;
    let base = head.peel_to_commit().map_err(format_git_error)?;
    let base_tree = base.tree().map_err(format_git_error)?;
    let branch = head.shorthand().unwrap_or("(no branch)");
    let oid_text = base.id().to_string();
    let summary = base.summary().ok().flatten().unwrap_or_default();
    let description = format!(
        "{branch}: {} {summary}\n",
        &oid_text[..7.min(oid_text.len())]
    );

    let mut index = repo.index().map_err(format_git_error)?;
    let staged_paths = changes
        .staged
        .iter()
        .chain(changes.staged_gitlinks.iter())
        .cloned()
        .collect::<Vec<_>>();
    let index_tree_oid = staged_tree_oid(repo, &base_tree, &mut index, &staged_paths)?;
    let index_tree = repo.find_tree(index_tree_oid).map_err(format_git_error)?;
    let index_message = format!("index on {description}");
    let index_commit_oid = repo
        .commit(
            None,
            signature,
            signature,
            &index_message,
            &index_tree,
            &[&base],
        )
        .map_err(format_git_error)?;
    let index_commit = repo
        .find_commit(index_commit_oid)
        .map_err(format_git_error)?;

    // `git stash push --staged` stores the current index tree as both the
    // index parent and the stash worktree tree. The staged patch is then
    // applied in reverse to index+worktree; overlap conflicts therefore leave
    // the newly created stash entry in place and return an error, like Git.
    let worktree_message = format!("WIP on {description}");
    let worktree_oid = repo
        .commit(
            None,
            signature,
            signature,
            &worktree_message,
            &index_tree,
            &[&base, &index_commit],
        )
        .map_err(format_git_error)?;
    let reflog_message = worktree_message.trim_end();
    repo.reference_ensure_log("refs/stash")
        .map_err(format_git_error)?;
    repo.reference("refs/stash", worktree_oid, true, reflog_message)
        .map_err(format_git_error)?;

    let regular_paths = &changes.staged;
    let overlaps_worktree = regular_paths
        .iter()
        .any(|path| changes.unstaged.contains(path));
    let changes_attributes = regular_paths.iter().any(|path| {
        Path::new(path).file_name().is_some_and(|name| {
            name.to_string_lossy()
                .eq_ignore_ascii_case(".gitattributes")
        })
    });
    if !overlaps_worktree && !changes_attributes {
        restore_staged_paths(repo, regular_paths, filtered_paths, default_attributes).map_err(
            |error| format!("stash 已创建（{worktree_oid}），但还原已暂存修改失败: {error}"),
        )?;
    } else if !regular_paths.is_empty() {
        let mut diff_options = DiffOptions::new();
        diff_options
            .include_typechange(true)
            .disable_pathspec_match(true)
            .reverse(true);
        for path in regular_paths {
            diff_options.pathspec(path);
        }
        let reverse = repo
            .diff_tree_to_index(Some(&base_tree), Some(&index), Some(&mut diff_options))
            .map_err(format_git_error)?;
        if overlaps_worktree
            && staged_hunks_overlap_worktree(repo, &reverse, &index, regular_paths)?
        {
            return Err(format!(
                "stash 已创建（{worktree_oid}），但 staged 与 unstaged 修改重叠，无法像 Git 一样反向应用"
            ));
        }
        repo.apply(&reverse, ApplyLocation::WorkDir, None)
            .map_err(|error| {
                format!(
                    "stash 已创建（{worktree_oid}），但移除工作区中的已暂存修改失败: {}",
                    format_git_error(error)
                )
            })?;
        repo.reset_default(
            Some(base.as_object()),
            regular_paths.iter().map(String::as_str),
        )
        .map_err(|error| {
            format!(
                "stash 已创建（{worktree_oid}），但还原暂存区失败: {}",
                format_git_error(error)
            )
        })?;
    }
    reset_staged_gitlinks(repo, &changes.staged_gitlinks).map_err(|error| {
        format!("stash 已创建（{worktree_oid}），但还原已暂存子模块指针失败: {error}")
    })?;
    Ok(worktree_oid)
}

fn create_unstaged_paths(
    repo: &Repository,
    signature: &git2::Signature<'_>,
    index_base_paths: &[String],
    capture_paths: &[String],
    preserve_paths: &[String],
    reset_paths: &[String],
    default_attributes: bool,
) -> NativeResult<Oid> {
    let encode = |paths: &[String]| {
        paths
            .iter()
            .map(|path| {
                CString::new(path.as_bytes())
                    .map_err(|_| format!("路径包含无效的 NUL 字符: {path}"))
            })
            .collect::<Result<Vec<_>, _>>()
    };
    let index_base = encode(index_base_paths)?;
    let index_base_pointers = index_base
        .iter()
        .map(|path| path.as_ptr())
        .collect::<Vec<_>>();
    let capture = encode(capture_paths)?;
    let capture_pointers = capture.iter().map(|path| path.as_ptr()).collect::<Vec<_>>();
    let preserve = encode(preserve_paths)?;
    let preserve_pointers = preserve
        .iter()
        .map(|path| path.as_ptr())
        .collect::<Vec<_>>();
    let reset = encode(reset_paths)?;
    let reset_pointers = reset.iter().map(|path| path.as_ptr()).collect::<Vec<_>>();
    let mut output = [0 as c_char; 65];
    let flags = (StashFlags::KEEP_INDEX | StashFlags::INCLUDE_UNTRACKED).bits();
    let result = unsafe {
        git_stash_save_unstaged_paths(
            output.as_mut_ptr(),
            output.len(),
            repo.raw().cast(),
            signature.raw().cast(),
            flags,
            index_base_pointers.len(),
            index_base_pointers.as_ptr(),
            capture_pointers.len(),
            capture_pointers.as_ptr(),
            preserve_pointers.len(),
            preserve_pointers.as_ptr(),
            reset_pointers.len(),
            reset_pointers.as_ptr(),
            default_attributes,
        )
    };
    if result < 0 {
        return Err(stash_error(git2::Error::last_error(result)));
    }
    let text = unsafe { CStr::from_ptr(output.as_ptr()) }
        .to_str()
        .map_err(|_| "libgit2 返回了无效的 stash OID".to_owned())?;
    Oid::from_str(text).map_err(|_| "libgit2 返回了无效的 stash OID".to_owned())
}

pub fn create(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let scope = parse_scope(payload)?;
    let repo = open_repository(root_path)?;
    let index = repo.index().map_err(format_git_error)?;
    if index.has_conflicts() {
        return Err("存在未解决的合并冲突，请先解决冲突后再 stash".to_owned());
    }
    if index.iter().any(|entry| {
        IndexEntryExtendedFlag::from_bits_retain(entry.flags_extended).is_intent_to_add()
    }) {
        return Err("暂存区包含 intent-to-add 文件，Git 无法创建 stash".to_owned());
    }
    let signature = repo.signature().map_err(|_| NO_IDENTITY.to_owned())?;
    let paths = parse_paths(payload)?;
    let merge_staged_into_unstaged = merge_staged_into_unstaged_arg(payload)?;
    let all_unstaged_paths = all_unstaged_paths_arg(payload)?;
    if all_unstaged_paths && (scope != Scope::Unstaged || paths.is_none()) {
        return Err("allUnstagedPaths 只允许与 unstaged 精确路径一起使用".to_owned());
    }
    let mut all_changes = collect_changes(&repo, !all_unstaged_paths)?;
    if all_unstaged_paths {
        let selected = paths.as_ref().expect("validated allUnstagedPaths");
        let index = repo.index().map_err(format_git_error)?;
        let head_tree = repo
            .head()
            .map_err(|_| NO_COMMIT.to_owned())?
            .peel_to_tree()
            .map_err(format_git_error)?;
        for path in selected {
            if is_gitlink(&index, &head_tree, path) {
                all_changes.unstaged_gitlinks.push(path.clone());
            } else {
                all_changes.unstaged.push(path.clone());
            }
        }
    }
    let mut changes = all_changes.clone();
    if let Some(selected_paths) = &paths {
        match scope {
            Scope::Unstaged => {
                changes
                    .unstaged
                    .retain(|path| selected_paths.contains(path));
                changes
                    .unstaged_gitlinks
                    .retain(|path| selected_paths.contains(path));
            }
            Scope::Staged => {
                changes.staged.retain(|path| selected_paths.contains(path));
                changes
                    .staged_gitlinks
                    .retain(|path| selected_paths.contains(path));
            }
        }
    }

    let (files, skipped): (Vec<String>, Vec<String>) = match scope {
        Scope::Unstaged => (changes.unstaged.clone(), changes.unstaged_gitlinks.clone()),
        Scope::Staged => {
            let files = changes
                .staged
                .iter()
                .chain(changes.staged_gitlinks.iter())
                .cloned()
                .collect::<BTreeSet<_>>();
            (files.into_iter().collect(), Vec::new())
        }
    };
    let has_tracked_unstaged = if scope == Scope::Staged && changes.staged.is_empty() {
        let index = repo.index().map_err(format_git_error)?;
        let head_tree = repo
            .head()
            .map_err(|_| NO_COMMIT.to_owned())?
            .peel_to_tree()
            .map_err(format_git_error)?;
        changes.unstaged.iter().any(|path| {
            index.get_path(Path::new(path), 0).is_some()
                || head_tree.get_path(Path::new(path)).is_ok()
        })
    } else {
        true
    };
    if scope == Scope::Staged && files.is_empty() && has_tracked_unstaged {
        return Err("工作区有未暂存修改，但没有可 stash 的已暂存修改".to_owned());
    }
    if files.is_empty()
        || (scope == Scope::Staged && changes.staged.is_empty() && !has_tracked_unstaged)
    {
        let skipped = if scope == Scope::Staged {
            changes.staged_gitlinks.clone()
        } else {
            skipped
        };
        return Ok(json!({
            "stash": "",
            "created": false,
            "skippedGitlinks": skipped,
        }));
    }
    let regular_files = {
        let index = repo.index().map_err(format_git_error)?;
        let head_tree = repo
            .head()
            .map_err(|_| NO_COMMIT.to_owned())?
            .peel_to_tree()
            .map_err(format_git_error)?;
        files
            .iter()
            .filter(|path| !is_gitlink(&index, &head_tree, path))
            .cloned()
            .collect::<Vec<_>>()
    };
    let selected_unstaged = regular_files.iter().cloned().collect::<BTreeSet<_>>();
    let staged_paths = all_changes
        .staged
        .iter()
        .chain(all_changes.staged_gitlinks.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    let overlapping_staged = selected_unstaged
        .intersection(&staged_paths)
        .cloned()
        .collect::<BTreeSet<_>>();
    // These paths keep their full worktree contents in the stash worktree tree, but they
    // are deliberately excluded from the stash index parent: applying the stash restores
    // the combined contents as unstaged changes and never stages them.
    let related_staged_worktree_paths = if scope == Scope::Unstaged {
        related_staged_paths(&repo, &overlapping_staged)?
    } else {
        Vec::new()
    };
    let index_base_paths = if scope == Scope::Unstaged && !merge_staged_into_unstaged {
        related_staged_worktree_paths.clone()
    } else {
        Vec::new()
    };
    let preserved_staged_worktree_paths = if scope == Scope::Unstaged && merge_staged_into_unstaged
    {
        related_staged_worktree_paths
    } else {
        Vec::new()
    };
    let isolation = if scope == Scope::Unstaged {
        Some(isolate_unselected_unstaged(
            &repo,
            &all_changes.unstaged,
            &selected_unstaged,
        )?)
        .flatten()
    } else {
        None
    };
    let default_paths = match scope {
        Scope::Staged => regular_files.clone(),
        Scope::Unstaged => regular_files
            .iter()
            .chain(changes.staged.iter())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>(),
    };
    let default_flags = stash_filter_flags(&repo, &default_paths)?;
    let flags_by_path = default_paths
        .iter()
        .zip(default_flags.iter().copied())
        .collect::<BTreeMap<_, _>>();
    let filter_flags = regular_files
        .iter()
        .map(|path| {
            flags_by_path
                .get(path)
                .copied()
                .ok_or_else(|| format!("缺少 stash filter 标志: {path}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    ensure_stashable_with_flags(&repo, &regular_files, &filter_flags, "创建 stash")?;
    let external_paths = regular_files
        .iter()
        .zip(filter_flags.iter().copied())
        .filter_map(|(path, flags)| stash_path_uses_external_filter(flags).then_some(path.clone()))
        .collect::<Vec<_>>();
    let default_attributes = !default_paths.is_empty()
        && !default_paths.iter().any(|path| {
            Path::new(path).file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .eq_ignore_ascii_case(".gitattributes")
            })
        })
        && default_flags
            .iter()
            .all(|flags| stash_path_uses_default_attributes(*flags));
    let filtered_paths = regular_files
        .iter()
        .zip(filter_flags.iter().copied())
        .filter_map(|(path, flags)| stash_path_needs_builtin_filter(flags).then_some(path.clone()))
        .collect::<BTreeSet<_>>();

    let backups = if scope == Scope::Unstaged {
        match clean_worktree_for_stash(&repo, &external_paths) {
            Ok(backups) => backups,
            Err(error) => {
                if let Some(isolation) = &isolation {
                    let _ = restore_unstaged_isolation(&repository_root(&repo)?, isolation);
                }
                return Err(error);
            }
        }
    } else {
        Vec::new()
    };
    let oid_result = match scope {
        Scope::Unstaged => {
            let capture_paths = regular_files
                .iter()
                .chain(preserved_staged_worktree_paths.iter())
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let reset_paths = capture_paths
                .iter()
                .chain(changes.staged.iter().filter(|path| {
                    flags_by_path.get(*path).is_some_and(|flags| {
                        stash_path_needs_builtin_filter(*flags)
                            || stash_path_uses_external_filter(*flags)
                    })
                }))
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            create_unstaged_paths(
                &repo,
                &signature,
                &index_base_paths,
                &capture_paths,
                &preserved_staged_worktree_paths,
                &reset_paths,
                default_attributes,
            )
        }
        Scope::Staged => create_staged_stash(
            &repo,
            &signature,
            &changes,
            &filtered_paths,
            default_attributes,
        ),
    };
    let oid = match oid_result {
        Ok(oid) => oid,
        Err(error) => {
            restore_worktree_backups(backups)?;
            if let Some(isolation) = &isolation {
                restore_unstaged_isolation(&repository_root(&repo)?, isolation)?;
            }
            return Err(error);
        }
    };
    if let Err(error) = smudge_worktree_paths(&repo, &external_paths) {
        restore_worktree_backups(backups)?;
        if let Some(isolation) = &isolation {
            restore_unstaged_isolation(&repository_root(&repo)?, isolation)?;
        }
        return Err(error);
    }
    if let Some(isolation) = &isolation {
        restore_unstaged_isolation(&repository_root(&repo)?, isolation)?;
    }
    Ok(json!({
        "stash": oid.to_string(),
        "created": true,
        "skippedGitlinks": skipped,
    }))
}

fn checkout_stash_tree_paths(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    paths: &[String],
) -> NativeResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut source = git2::Index::new().map_err(format_git_error)?;
    source.read_tree(tree).map_err(format_git_error)?;
    // 与普通文件还原一致逐路径 checkout，避免 Windows 上多个 pathspec 扩大扫描范围。
    for path in paths {
        let mut checkout = CheckoutBuilder::new();
        checkout
            .force()
            .recreate_missing(true)
            .update_index(false)
            .disable_filters(true)
            .disable_pathspec_match(true)
            .path(path);
        repo.checkout_index(Some(&mut source), Some(&mut checkout))
            .map_err(format_git_error)?;
    }
    Ok(())
}

/// 将 stash 中选定路径的快照还原到工作区；不修改 index，也不删除 stash 条目。
pub fn restore_paths(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let hash = string_arg(payload, "stash")?;
    let requested = string_array(payload, "paths")?
        .into_iter()
        .map(|path| normalize(&path))
        .collect::<BTreeSet<_>>();
    if requested.is_empty() {
        return Ok(Value::Null);
    }
    let repo = open_repository(root_path)?;
    let oid = parse_stash_hash(hash)?;
    let commit = repo.find_commit(oid).map_err(format_git_error)?;
    if commit.parent_count() < 2 {
        return Err(format!("{} 不是 stash 提交", commit.id()));
    }
    let index = repo.index().map_err(format_git_error)?;
    if index.has_conflicts() {
        return Err("存在未解决的合并冲突，请先解决冲突后再还原贮藏".to_owned());
    }
    let stash_tree = commit.tree().map_err(format_git_error)?;
    let base_parent = if is_unstaged_only_stash(&commit) {
        1
    } else {
        0
    };
    let base_tree = commit
        .parent(base_parent)
        .and_then(|parent| parent.tree())
        .map_err(format_git_error)?;
    let mut options = DiffOptions::new();
    options.include_typechange(true);
    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&stash_tree), Some(&mut options))
        .map_err(format_git_error)?;
    let mut available = BTreeSet::new();
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(path) = file.path() {
                available.insert(normalize(&path.to_string_lossy()));
            }
        }
    }
    let untracked_tree = if commit.parent_count() >= 3 {
        Some(
            commit
                .parent(2)
                .and_then(|parent| parent.tree())
                .map_err(format_git_error)?,
        )
    } else {
        None
    };
    if let Some(tree) = &untracked_tree {
        tree.walk(TreeWalkMode::PreOrder, |directory, entry| {
            if entry.kind() == Some(ObjectType::Blob) {
                available.insert(format!(
                    "{directory}{}",
                    String::from_utf8_lossy(entry.name_bytes())
                ));
            }
            TreeWalkResult::Ok
        })
        .map_err(format_git_error)?;
    }
    let missing = requested
        .iter()
        .filter(|path| !available.contains(*path))
        .cloned()
        .collect::<BTreeSet<_>>();
    if !missing.is_empty() {
        return Err(format!("贮藏中不包含这些文件：{}", preview(&missing)));
    }

    let mut status_options = StatusOptions::new();
    status_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .exclude_submodules(false);
    let dirty = repo
        .statuses(Some(&mut status_options))
        .map_err(format_git_error)?
        .iter()
        .filter_map(|entry| {
            let path = normalize(&String::from_utf8_lossy(entry.path_bytes()));
            requested.contains(&path).then_some(path)
        })
        .collect::<BTreeSet<_>>();
    if !dirty.is_empty() {
        return Err(format!(
            "以下文件已有本地修改，已拒绝还原贮藏以免覆盖：{}",
            preview(&dirty)
        ));
    }

    let selected = requested.iter().cloned().collect::<Vec<_>>();
    ensure_stashable(&repo, &selected, "还原贮藏")?;
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    let mut deleted = Vec::new();
    for path in &selected {
        if untracked_tree
            .as_ref()
            .is_some_and(|tree| tree.get_path(Path::new(path)).is_ok())
        {
            untracked.push(path.clone());
        } else if stash_tree.get_path(Path::new(path)).is_ok() {
            tracked.push(path.clone());
        } else {
            deleted.push(path.clone());
        }
    }
    checkout_stash_tree_paths(&repo, &stash_tree, &tracked)?;
    if let Some(tree) = &untracked_tree {
        checkout_stash_tree_paths(&repo, tree, &untracked)?;
    }
    let root = repository_root(&repo)?;
    for path in &deleted {
        remove_worktree_path(&root, path)?;
    }
    smudge_worktree_paths(&repo, &selected)?;
    Ok(Value::Null)
}

fn stash_list_entry(repo: &Repository, index: usize, oid: Oid) -> Option<Value> {
    let commit = repo.find_commit(oid).ok()?;
    let author = commit.author();
    let committer = commit.committer();
    Some(json!({
        "hash": oid.to_string(),
        "shortHash": oid.to_string().chars().take(8).collect::<String>(),
        "parents": commit.parent_ids().map(|id| id.to_string()).collect::<Vec<_>>(),
        "author": signature_text(author.name_bytes(), "Unknown author"),
        "authorEmail": signature_text(author.email_bytes(), ""),
        "committer": signature_text(committer.name_bytes(), "Unknown committer"),
        "committerEmail": signature_text(committer.email_bytes(), ""),
        "authorDate": iso_time(author.when()),
        "message": commit.summary().unwrap_or_default(),
        "body": commit.body().unwrap_or_default(),
        "rawMessage": String::from_utf8_lossy(commit.message_bytes()),
        "refs": Vec::<String>::new(),
        "commitTime": commit.time().seconds(),
        "stashIndex": index,
        "stashRef": format!("stash@{{{index}}}"),
    }))
}

pub fn list(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let mut repo = open_repository(root_path)?;
    let mut entries: Vec<(usize, Oid)> = Vec::new();
    repo.stash_foreach(|index, _message, oid| {
        entries.push((index, *oid));
        true
    })
    .map_err(format_git_error)?;
    Ok(Value::Array(
        entries
            .into_iter()
            .filter_map(|(index, oid)| stash_list_entry(&repo, index, oid))
            .collect(),
    ))
}

fn coalesce_exact_renames(values: &mut Vec<Value>) {
    let mut deleted = BTreeMap::<(String, String), Vec<usize>>::new();
    for (index, value) in values.iter().enumerate() {
        if value.get("status").and_then(Value::as_str) != Some("D") {
            continue;
        }
        let Some(oid) = value.get("oldObjectId").and_then(Value::as_str) else {
            continue;
        };
        let Some(mode) = value.get("oldMode").and_then(Value::as_str) else {
            continue;
        };
        deleted
            .entry((oid.to_owned(), mode.to_owned()))
            .or_default()
            .push(index);
    }
    let mut removed = Vec::new();
    for added_index in 0..values.len() {
        if values[added_index].get("status").and_then(Value::as_str) != Some("A") {
            continue;
        }
        let Some(oid) = values[added_index]
            .get("newObjectId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let Some(mode) = values[added_index]
            .get("newMode")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let Some(deleted_index) = deleted.get_mut(&(oid, mode)).and_then(Vec::pop) else {
            continue;
        };
        let old_path = values[deleted_index]
            .get("path")
            .cloned()
            .unwrap_or(Value::Null);
        let old_oid = values[deleted_index]
            .get("oldObjectId")
            .cloned()
            .unwrap_or(Value::Null);
        let old_mode = values[deleted_index]
            .get("oldMode")
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(added) = values[added_index].as_object_mut() {
            added.insert("status".to_owned(), Value::String("R".to_owned()));
            added.insert("oldPath".to_owned(), old_path);
            added.insert("oldObjectId".to_owned(), old_oid);
            added.insert("oldMode".to_owned(), old_mode);
        }
        removed.push(deleted_index);
    }
    removed.sort_unstable();
    removed.dedup();
    for index in removed.into_iter().rev() {
        values.remove(index);
    }
}

/// stash 提交的变更文件：普通 stash 使用第 1 个父提交作为基线；
/// “仅贮藏未暂存修改”使用第 2 个父提交，以免把已暂存差异显示为贮藏内容。
/// 最后再合并第 3 个父提交里的未跟踪文件。
pub fn files(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let revision = string_arg(payload, "revision")?;
    let repo = open_repository(root_path)?;
    let commit = repo
        .revparse_single(revision)
        .map_err(format_git_error)?
        .peel_to_commit()
        .map_err(format_git_error)?;
    if commit.parent_count() < 2 {
        return Err(format!("{revision} 不是 stash 提交"));
    }
    let tree = commit.tree().map_err(format_git_error)?;
    let base_parent = if is_unstaged_only_stash(&commit) {
        1
    } else {
        0
    };
    let base_tree = commit
        .parent(base_parent)
        .and_then(|parent| parent.tree())
        .map_err(format_git_error)?;
    let mut options = DiffOptions::new();
    options.include_typechange(true);
    let mut diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&tree), Some(&mut options))
        .map_err(format_git_error)?;
    if diff.deltas().any(|delta| delta.status() == Delta::Added)
        && diff.deltas().any(|delta| delta.status() == Delta::Deleted)
    {
        let mut find = DiffFindOptions::new();
        find.renames(true);
        let _ = diff.find_similar(Some(&mut find));
    }
    let mut values: Vec<Value> = diff.deltas().map(delta_value).collect();

    if commit.parent_count() >= 3 {
        let untracked_tree = commit
            .parent(2)
            .and_then(|parent| parent.tree())
            .map_err(format_git_error)?;
        let zero = Oid::ZERO_SHA1.to_string();
        untracked_tree
            .walk(TreeWalkMode::PreOrder, |directory, entry| {
                if entry.kind() == Some(ObjectType::Blob) {
                    let path =
                        format!("{directory}{}", String::from_utf8_lossy(entry.name_bytes()));
                    values.push(json!({
                        "path": path,
                        "status": "A",
                        "oldPath": Value::Null,
                        "oldObjectId": zero,
                        "newObjectId": entry.id().to_string(),
                        "oldMode": "000000",
                        "newMode": format!("{:06o}", entry.filemode_raw()),
                        "isGitlink": false,
                    }));
                }
                TreeWalkResult::Ok
            })
            .map_err(format_git_error)?;
    }
    coalesce_exact_renames(&mut values);
    Ok(Value::Array(values))
}

const ABSENT_STASH: &str = "该 stash 已不存在，可能已被其他操作应用或删除";

fn parse_stash_hash(hash: &str) -> NativeResult<Oid> {
    if hash.len() != 40 {
        return Err(format!("无效的 stash 标识: {hash}"));
    }
    Oid::from_str(hash).map_err(|_| format!("无效的 stash 标识: {hash}"))
}

/// 按 stash 提交 hash 查当前序号。序号会随其他 stash 操作移位，hash 才是稳定标识。
fn stash_index(repo: &mut Repository, hash: &str) -> NativeResult<usize> {
    let target = parse_stash_hash(hash)?;
    let mut found = None;
    repo.stash_foreach(|index, _message, oid| {
        if *oid == target {
            found = Some(index);
            false
        } else {
            true
        }
    })
    .map_err(format_git_error)?;
    found.ok_or_else(|| ABSENT_STASH.to_owned())
}

fn preview(paths: &BTreeSet<String>) -> String {
    let shown: Vec<&str> = paths.iter().take(5).map(String::as_str).collect();
    if paths.len() > shown.len() {
        format!("{} 等共 {} 个文件", shown.join("、"), paths.len())
    } else {
        shown.join("、")
    }
}

#[derive(Clone, Copy)]
enum ApplyFilters {
    Standard,
    Disabled,
    DefaultAttributes,
}

struct ApplyPlan {
    filters: ApplyFilters,
    external_paths: Vec<String>,
    checkout_paths: Vec<String>,
}

unsafe extern "C" {
    fn git_stash_apply_default_attributes(
        repository: *mut c_void,
        index: usize,
        options: *const c_void,
    ) -> i32;
    fn git_stash_checkout_index_default_attributes(
        repository: *mut c_void,
        index: *mut c_void,
        path_count: usize,
        paths: *const *const c_char,
    ) -> i32;
    fn git_stash_save_unstaged_paths(
        output: *mut c_char,
        output_size: usize,
        repository: *mut c_void,
        stasher: *const c_void,
        flags: u32,
        index_base_path_count: usize,
        index_base_paths: *const *const c_char,
        capture_path_count: usize,
        capture_paths: *const *const c_char,
        preserve_path_count: usize,
        preserve_paths: *const *const c_char,
        reset_path_count: usize,
        reset_paths: *const *const c_char,
        default_attributes: bool,
    ) -> i32;
}

fn preflight_apply(repo: &Repository, stash: &Commit<'_>) -> NativeResult<ApplyPlan> {
    if stash.parent_count() < 2 {
        return Err(format!("{} 不是 stash 提交", stash.id()));
    }
    let index = repo.index().map_err(format_git_error)?;
    if index.has_conflicts() {
        return Err("存在未解决的合并冲突，请先解决冲突后再应用 stash".to_owned());
    }
    let head_tree = repo
        .head()
        .map_err(|_| "仓库还没有任何提交，无法应用 stash".to_owned())?
        .peel_to_tree()
        .map_err(format_git_error)?;
    let base_parent = if is_unstaged_only_stash(stash) { 1 } else { 0 };
    let base_tree = stash
        .parent(base_parent)
        .and_then(|parent| parent.tree())
        .map_err(format_git_error)?;
    let tree = stash.tree().map_err(format_git_error)?;
    let mut options = DiffOptions::new();
    options.include_typechange(true);
    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&tree), Some(&mut options))
        .map_err(format_git_error)?;
    let mut touched = BTreeSet::new();
    let mut added = BTreeSet::new();
    for delta in diff.deltas() {
        if let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) {
            let path = normalize(&path.to_string_lossy());
            touched.insert(path.clone());
            if delta.status() == Delta::Added {
                added.insert(path);
            }
        }
    }
    let mut untracked = BTreeSet::new();
    if stash.parent_count() >= 3 {
        let untracked_tree = stash
            .parent(2)
            .and_then(|parent| parent.tree())
            .map_err(format_git_error)?;
        untracked_tree
            .walk(TreeWalkMode::PreOrder, |directory, entry| {
                if entry.kind() == Some(ObjectType::Blob) {
                    untracked.insert(format!(
                        "{directory}{}",
                        String::from_utf8_lossy(entry.name_bytes())
                    ));
                }
                TreeWalkResult::Ok
            })
            .map_err(format_git_error)?;
    }

    let root = repository_root(repo)?;
    let clashes = added
        .iter()
        .chain(untracked.iter())
        .filter(|path| root.join(path.as_str()).symlink_metadata().is_ok())
        .cloned()
        .collect::<BTreeSet<_>>();
    if !clashes.is_empty() {
        return Err(format!(
            "以下文件在工作区已存在或有本地修改，与 stash 重叠，已拒绝应用以免覆盖：{}",
            preview(&clashes)
        ));
    }
    let paths = touched
        .iter()
        .chain(untracked.iter())
        .cloned()
        .collect::<Vec<_>>();
    let flags = ensure_stashable(repo, &paths, "应用 stash")?;
    // A moved baseline can produce merge/conflict paths outside the stash diff.
    // Attribute changes can also change the filters needed during checkout.
    let fixed_base = base_tree.id() == head_tree.id()
        && !paths.iter().any(|path| {
            Path::new(path).file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .eq_ignore_ascii_case(".gitattributes")
            })
        });
    let external_paths = paths
        .iter()
        .zip(flags.iter().copied())
        .filter_map(|(path, flags)| stash_path_uses_external_filter(flags).then_some(path.clone()))
        .collect::<Vec<_>>();
    let filters = if fixed_base
        && flags
            .iter()
            .all(|flags| stash_path_uses_default_attributes(*flags))
    {
        ApplyFilters::DefaultAttributes
    } else if fixed_base && !flags.iter().copied().any(stash_path_needs_builtin_filter) {
        ApplyFilters::Disabled
    } else {
        ApplyFilters::Standard
    };
    let checkout_paths = if fixed_base
        && diff
            .deltas()
            .all(|delta| delta.status() != Delta::Typechange)
    {
        paths
    } else {
        Vec::new()
    };
    Ok(ApplyPlan {
        filters,
        external_paths,
        checkout_paths,
    })
}

fn apply_error(error: git2::Error) -> String {
    match error.code() {
        ErrorCode::Uncommitted => "应用 stash 需要暂存区是干净的，请先提交或取消暂存".to_owned(),
        ErrorCode::Conflict => {
            "本地修改与 stash 冲突，应用被中止；请检查工作区状态后重试".to_owned()
        }
        _ => format_git_error(error),
    }
}

fn stash_reinstate_index(repo: &Repository) -> NativeResult<bool> {
    let config = repo.config().map_err(format_git_error)?;
    match config.get_bool("stash.index") {
        Ok(value) => Ok(value),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(false),
        Err(error) => Err(format_git_error(error)),
    }
}

fn apply_by_hash(repo: &mut Repository, hash: &str) -> NativeResult<bool> {
    let reinstate_index = stash_reinstate_index(repo)?;
    let index = stash_index(repo, hash)?;
    let oid = parse_stash_hash(hash)?;
    let plan = {
        let commit = repo.find_commit(oid).map_err(format_git_error)?;
        preflight_apply(repo, &commit)?
    };
    let mut checkout = CheckoutBuilder::new();
    checkout
        .ancestor_label("Stash base")
        .our_label("Updated upstream")
        .their_label("Stashed changes")
        .disable_filters(matches!(plan.filters, ApplyFilters::Disabled));
    if !plan.checkout_paths.is_empty() {
        checkout.disable_pathspec_match(true);
        for path in &plan.checkout_paths {
            checkout.path(path);
        }
    }
    let mut options = StashApplyOptions::new();
    if reinstate_index {
        options.reinstantiate_index();
    }
    options.checkout_options(checkout);
    if matches!(plan.filters, ApplyFilters::DefaultAttributes) {
        let options_ptr = options.raw() as *const _ as *const c_void;
        // SAFETY: the repository and apply options remain alive for this synchronous call.
        let result =
            unsafe { git_stash_apply_default_attributes(repo.raw().cast(), index, options_ptr) };
        if result < 0 {
            return Err(apply_error(git2::Error::last_error(result)));
        }
    } else {
        repo.stash_apply(index, Some(&mut options))
            .map_err(apply_error)?;
    }
    let conflicts = repo.index().map_err(format_git_error)?.has_conflicts();
    if !conflicts {
        smudge_worktree_paths(repo, &plan.external_paths)?;
    }
    Ok(conflicts)
}

pub fn apply(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let hash = string_arg(payload, "stash")?;
    let mut repo = open_repository(root_path)?;
    let conflicts = apply_by_hash(&mut repo, hash)?;
    Ok(json!({ "stash": hash, "conflicts": conflicts, "dropped": false }))
}

pub fn pop(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let hash = string_arg(payload, "stash")?;
    let mut repo = open_repository(root_path)?;
    let conflicts = apply_by_hash(&mut repo, hash)?;
    if conflicts {
        return Ok(json!({ "stash": hash, "conflicts": true, "dropped": false }));
    }
    let index = stash_index(&mut repo, hash)?;
    repo.stash_drop(index).map_err(format_git_error)?;
    Ok(json!({ "stash": hash, "conflicts": false, "dropped": true }))
}

pub fn drop_stash(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let hash = string_arg(payload, "stash")?;
    let mut repo = open_repository(root_path)?;
    let index = stash_index(&mut repo, hash)?;
    repo.stash_drop(index).map_err(format_git_error)?;
    Ok(json!({ "stash": hash }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_renames_are_coalesced() {
        let oid = "df967b96a579e45a18b8251732d16804b2e56a55";
        let mut values = vec![
            json!({
                "path": "a", "status": "D", "oldPath": Value::Null,
                "oldObjectId": oid, "newObjectId": Oid::ZERO_SHA1.to_string(),
                "oldMode": "100644", "newMode": "000000", "isGitlink": false,
            }),
            json!({
                "path": "renamed", "status": "A", "oldPath": Value::Null,
                "oldObjectId": Oid::ZERO_SHA1.to_string(), "newObjectId": oid,
                "oldMode": "000000", "newMode": "100644", "isGitlink": false,
            }),
        ];
        coalesce_exact_renames(&mut values);
        assert_eq!(values.len(), 1);
        assert_eq!(values[0]["status"], "R");
        assert_eq!(values[0]["oldPath"], "a");
    }

    #[test]
    fn empty_restore_never_checks_out_unrelated_paths() {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        let signature = git2::Signature::now("Stash Test", "stash@example.com").unwrap();
        let path = directory.path().join("file");
        std::fs::write(&path, "base\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "base", &tree, &[])
            .unwrap();
        std::fs::write(&path, "unrelated edit\n").unwrap();
        restore_worktree_paths(&repo, &[], false, false).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "unrelated edit\n");
    }
}
