//! 纯 libgit2 实现的 stash 创建、读取、应用与删除。
//!
//! stashCreate 的 scope:
//! - unstaged: KEEP_INDEX | INCLUDE_UNTRACKED。
//! - staged:   手工构建标准双父 Stash commit，再用反向 staged diff 更新 index/worktree。
//!
//! Apply/Pop/Drop 全部通过 libgit2；应用前执行安全预检，避免 libgit2 在冲突时留下半应用工作区。
use crate::filters::{ensure_stashable, stash_path_needs_builtin_filter};
use crate::history::{delta_value, iso_time, signature_text};
use crate::support::{
    NativeResult, format_git_error, open_repository, repository_root, string_arg,
};
use git2::{
    ApplyLocation, Commit, Delta, DiffFindOptions, DiffOptions, ErrorClass, ErrorCode, FileMode,
    ObjectType, Oid, Repository, StashFlags, Status, StatusOptions, TreeWalkMode, TreeWalkResult,
    build::CheckoutBuilder,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;

const GITLINK_MODE: u32 = 0o160000;
const NO_COMMIT: &str = "仓库还没有任何提交，无法 stash";
const NO_IDENTITY: &str = "无法确定提交者身份，请先配置 user.name 和 user.email";

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

#[derive(Default)]
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

fn collect_changes(repo: &Repository) -> NativeResult<Changes> {
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
    Ok(changes)
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

fn restore_worktree_paths(
    repo: &Repository,
    paths: &[String],
    disable_filters: bool,
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
    repo.checkout_index(Some(&mut sparse), Some(&mut checkout))
        .map_err(format_git_error)
}

fn restore_staged_paths(
    repo: &Repository,
    paths: &[String],
    filtered_paths: &BTreeSet<String>,
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
        restore_worktree_paths(repo, &existing, false)?;
    } else {
        let (filtered, unfiltered): (Vec<_>, Vec<_>) = existing
            .into_iter()
            .partition(|path| filtered_paths.contains(path));
        restore_worktree_paths(repo, &unfiltered, true)?;
        restore_worktree_paths(repo, &filtered, false)?;
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

fn create_staged_stash(
    repo: &Repository,
    signature: &git2::Signature<'_>,
    changes: &Changes,
    filtered_paths: &BTreeSet<String>,
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
    let index_tree_oid = index.write_tree_to(repo).map_err(format_git_error)?;
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
    if !overlaps_worktree {
        restore_staged_paths(repo, regular_paths, filtered_paths).map_err(|error| {
            format!("stash 已创建（{worktree_oid}），但还原已暂存修改失败: {error}")
        })?;
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
        repo.apply(&reverse, ApplyLocation::Both, None)
            .map_err(|error| {
                format!(
                    "stash 已创建（{worktree_oid}），但移除已暂存修改失败: {}",
                    format_git_error(error)
                )
            })?;
    }
    reset_staged_gitlinks(repo, &changes.staged_gitlinks).map_err(|error| {
        format!("stash 已创建（{worktree_oid}），但还原已暂存子模块指针失败: {error}")
    })?;
    Ok(worktree_oid)
}

pub fn create(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let scope = parse_scope(payload)?;
    let mut repo = open_repository(root_path)?;
    if repo.index().map_err(format_git_error)?.has_conflicts() {
        return Err("存在未解决的合并冲突，请先解决冲突后再 stash".to_owned());
    }
    let signature = repo.signature().map_err(|_| NO_IDENTITY.to_owned())?;
    let changes = collect_changes(&repo)?;

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
    if files.is_empty() {
        return Err(match scope {
            Scope::Unstaged => "没有可 stash 的未暂存修改（子模块内部的修改不会被 stash）",
            Scope::Staged => "没有可 stash 的已暂存修改",
        }
        .to_owned());
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
    let filter_flags = ensure_stashable(&repo, &regular_files, "创建 stash")?;
    let filtered_paths = regular_files
        .iter()
        .zip(filter_flags)
        .filter_map(|(path, flags)| stash_path_needs_builtin_filter(flags).then_some(path.clone()))
        .collect::<BTreeSet<_>>();

    let oid = match scope {
        Scope::Unstaged => repo
            .stash_save2(
                &signature,
                None,
                Some(StashFlags::KEEP_INDEX | StashFlags::INCLUDE_UNTRACKED),
            )
            .map_err(stash_error)?,
        Scope::Staged => create_staged_stash(&repo, &signature, &changes, &filtered_paths)?,
    };
    Ok(json!({ "stash": oid.to_string(), "skippedGitlinks": skipped }))
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
    let mut result = Vec::with_capacity(entries.len());
    for (index, oid) in entries {
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let author = commit.author();
        let committer = commit.committer();
        result.push(json!({
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
        }));
    }
    Ok(Value::Array(result))
}

/// stash 提交的变更文件：第 1 个父提交（基线）到 stash 树的差异，外加第 3 个父提交里的未跟踪文件。
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
    let base_tree = commit
        .parent(0)
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

fn preflight_apply(repo: &Repository, stash: &Commit<'_>) -> NativeResult<()> {
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
    let staged = repo
        .diff_tree_to_index(Some(&head_tree), Some(&index), None)
        .map_err(format_git_error)?
        .deltas()
        .len();
    if staged > 0 {
        return Err(format!(
            "应用 stash 需要暂存区是干净的，当前有 {staged} 个已暂存的文件，请先提交或取消暂存"
        ));
    }

    let base_tree = stash
        .parent(0)
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
    let mut gitlinks = BTreeSet::new();
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if file.mode() == FileMode::Commit
                && let Some(path) = file.path()
            {
                gitlinks.insert(normalize(&path.to_string_lossy()));
            }
        }
        if let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path()) {
            let path = normalize(&path.to_string_lossy());
            touched.insert(path.clone());
            if delta.status() == Delta::Added {
                added.insert(path);
            }
        }
    }
    if !gitlinks.is_empty() {
        return Err(format!(
            "该 stash 包含子模块指针变更（{}），libgit2 无法安全应用",
            preview(&gitlinks)
        ));
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
    let mut clashes = added
        .iter()
        .chain(untracked.iter())
        .filter(|path| root.join(path.as_str()).symlink_metadata().is_ok())
        .cloned()
        .collect::<BTreeSet<_>>();
    if !touched.is_empty() {
        let mut status_options = StatusOptions::new();
        status_options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false)
            .exclude_submodules(true)
            .disable_pathspec_match(true);
        for path in &touched {
            status_options.pathspec(path);
        }
        let statuses = repo
            .statuses(Some(&mut status_options))
            .map_err(format_git_error)?;
        for entry in statuses.iter() {
            if is_worktree_change(entry.status()) {
                let path = normalize(&String::from_utf8_lossy(entry.path_bytes()));
                if touched.contains(&path) {
                    clashes.insert(path);
                }
            }
        }
    }
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
    ensure_stashable(repo, &paths, "应用 stash").map(|_| ())
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

fn apply_by_hash(repo: &mut Repository, hash: &str) -> NativeResult<bool> {
    let index = stash_index(repo, hash)?;
    let oid = parse_stash_hash(hash)?;
    {
        let commit = repo.find_commit(oid).map_err(format_git_error)?;
        preflight_apply(repo, &commit)?;
    }
    repo.stash_apply(index, None).map_err(apply_error)?;
    Ok(repo.index().map_err(format_git_error)?.has_conflicts())
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
        restore_worktree_paths(&repo, &[], false).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "unrelated edit\n");
    }
}
