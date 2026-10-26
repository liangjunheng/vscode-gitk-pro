use crate::filters::{worktree_data_matches_index, worktree_data_uses_external_filter};
use crate::support::{NativeResult, format_git_error, open_repository, string_arg, string_array};
use git2::{Delta, DiffDelta, FileMode, IndexEntry, Oid, Repository, Status, StatusOptions};
use once_cell::sync::Lazy;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc::{self, Sender},
};

type WorktreeReadJob = Box<dyn FnOnce() + Send + 'static>;

const MAX_PARALLEL_READ_BYTES: u64 = 64 * 1024 * 1024;
const STATUS_READ_WORKER_STACK_BYTES: usize = 512 * 1024;

struct WorktreeReadPool {
    senders: Vec<Sender<WorktreeReadJob>>,
    next: AtomicUsize,
}

impl WorktreeReadPool {
    fn new() -> Self {
        let worker_count = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(1);
        let mut senders = Vec::with_capacity(worker_count);
        for worker in 0..worker_count {
            let (sender, receiver) = mpsc::channel::<WorktreeReadJob>();
            let spawned = std::thread::Builder::new()
                .name(format!("fastergit-status-read-{worker}"))
                .stack_size(STATUS_READ_WORKER_STACK_BYTES)
                .spawn(move || {
                    while let Ok(job) = receiver.recv() {
                        job();
                    }
                });
            if spawned.is_err() {
                break;
            }
            senders.push(sender);
        }
        Self {
            senders,
            next: AtomicUsize::new(0),
        }
    }

    fn width(&self) -> usize {
        self.senders.len().max(1)
    }

    fn execute(&self, job: WorktreeReadJob) {
        if self.senders.is_empty() {
            job();
            return;
        }
        let index = self.next.fetch_add(1, Ordering::Relaxed) % self.senders.len();
        if let Err(error) = self.senders[index].send(job) {
            (error.0)();
        }
    }
}

static WORKTREE_READ_POOL: Lazy<WorktreeReadPool> = Lazy::new(WorktreeReadPool::new);

fn read_worktree_batch(root: Option<&Path>, paths: &[PathBuf]) -> Vec<Option<Vec<u8>>> {
    let Some(root) = root else {
        return std::iter::repeat_with(|| None).take(paths.len()).collect();
    };
    let (sender, receiver) = mpsc::channel();
    for (index, path) in paths.iter().enumerate() {
        let sender = sender.clone();
        let absolute = root.join(path);
        WORKTREE_READ_POOL.execute(Box::new(move || {
            let _ = sender.send((index, std::fs::read(absolute).ok()));
        }));
    }
    drop(sender);
    let mut output = std::iter::repeat_with(|| None)
        .take(paths.len())
        .collect::<Vec<_>>();
    for (index, contents) in receiver {
        output[index] = contents;
    }
    output
}

struct PendingWorktreeChange {
    path: PathBuf,
    size: u64,
    value: Option<Value>,
}

fn pending_batch_end(
    candidates: &[PendingWorktreeChange],
    start: usize,
    max_files: usize,
    max_bytes: u64,
) -> usize {
    let mut end = start;
    let mut bytes = 0u64;
    while end < candidates.len() && end - start < max_files.max(1) {
        let size = candidates[end].size.max(1);
        if end > start && bytes.saturating_add(size) > max_bytes.max(1) {
            break;
        }
        bytes = bytes.saturating_add(size);
        end += 1;
        if bytes >= max_bytes.max(1) {
            break;
        }
    }
    end
}

fn mode_text(mode: FileMode) -> String {
    format!("{:06o}", u32::from(mode))
}

fn index_mode_text(mode: u32) -> String {
    format!("{:06o}", mode)
}

fn zero_oid(length: usize) -> String {
    "0".repeat(length.max(40))
}

fn delta_status(delta: &DiffDelta<'_>) -> &'static str {
    match delta.status() {
        Delta::Added | Delta::Untracked => "A",
        Delta::Deleted => "D",
        Delta::Renamed => "R",
        Delta::Copied => "C",
        Delta::Typechange => "T",
        Delta::Conflicted => "U",
        _ => "M",
    }
}

fn path_of(delta: &DiffDelta<'_>) -> String {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn file_from_delta(delta: DiffDelta<'_>, conflict: bool, untracked: bool) -> Value {
    let old_file = delta.old_file();
    let new_file = delta.new_file();
    let path = path_of(&delta);
    let old_path = if matches!(delta.status(), Delta::Renamed | Delta::Copied) {
        old_file
            .path()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
    } else {
        None
    };
    let old_id = old_file.id().to_string();
    let new_id = new_file.id().to_string();
    let old_mode = mode_text(old_file.mode());
    let new_mode = mode_text(new_file.mode());
    json!({
        "path": path,
        "status": delta_status(&delta),
        "oldPath": old_path,
        "oldObjectId": old_id,
        "newObjectId": new_id,
        "oldMode": old_mode,
        "newMode": new_mode,
        "isGitlink": old_mode == "160000" || new_mode == "160000",
        "isConflict": conflict,
        "isUntracked": untracked,
    })
}

fn conflict_entry(entry: &IndexEntry) -> (String, String, String) {
    (
        String::from_utf8_lossy(&entry.path).into_owned(),
        entry.id.to_string(),
        index_mode_text(entry.mode),
    )
}

fn selected_path(paths: &[String], path: &str) -> bool {
    paths.is_empty()
        || paths
            .iter()
            .any(|selected| path == selected || path.starts_with(&format!("{selected}/")))
}

fn gitlink_pointer_value(path: &str, old: Option<Oid>, new: Option<Oid>) -> Value {
    let status = match (old, new) {
        (None, Some(_)) => "A",
        (Some(_), None) => "D",
        _ => "M",
    };
    json!({
        "path": path,
        "status": status,
        "oldObjectId": old.map(|oid| oid.to_string()).unwrap_or_else(|| zero_oid(40)),
        "newObjectId": new.map(|oid| oid.to_string()).unwrap_or_else(|| zero_oid(40)),
        "oldMode": if old.is_some() { "160000" } else { "000000" },
        "newMode": if new.is_some() { "160000" } else { "000000" },
        "isGitlink": true,
        "isConflict": false,
        "isUntracked": false,
    })
}

/// Fast parent-repository mode: do not recurse into child worktrees, but retain
/// actual Gitlink pointer changes by comparing HEAD, index and child HEAD OIDs.
fn append_submodule_pointer_changes(
    repo: &Repository,
    paths: &[String],
    staged: &mut Vec<Value>,
    changes: &mut Vec<Value>,
) -> NativeResult<()> {
    for module in repo.submodules().map_err(format_git_error)? {
        let path = module.path().to_string_lossy().replace('\\', "/");
        if !selected_path(paths, &path) {
            continue;
        }
        let head = module.head_id();
        let index = module.index_id();
        let workdir = module.workdir_id();
        if head != index
            && !staged
                .iter()
                .any(|file| file.get("path").and_then(Value::as_str) == Some(path.as_str()))
        {
            staged.push(gitlink_pointer_value(&path, head, index));
        }
        // An uninitialized child has no workdir OID and is not a deletion.
        if index.is_some()
            && workdir.is_some()
            && index != workdir
            && !changes
                .iter()
                .any(|file| file.get("path").and_then(Value::as_str) == Some(path.as_str()))
        {
            changes.push(gitlink_pointer_value(&path, index, workdir));
        }
    }
    Ok(())
}

pub fn status(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let paths = string_array(payload, "paths")?;
    let recurse = payload
        .get("recurseUntrackedDirs")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let skip_submodule_worktrees = payload
        .get("skipSubmoduleWorktrees")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let repo = open_repository(root_path)?;
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(recurse)
        .include_ignored(false)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .exclude_submodules(skip_submodule_worktrees)
        // A read must not rewrite .git/index: the index watcher would start
        // another full reconciliation for this very status request.
        .update_index(false);
    for path in &paths {
        options.pathspec(path);
    }
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(format_git_error)?;
    // Reuse one index for every worktree comparison instead of reopening and
    // parsing the entire index once per modified file.
    let index = repo.index().map_err(format_git_error)?;
    let mut staged = Vec::new();
    let mut changes = Vec::new();
    let mut pending_worktree_changes = Vec::new();
    for entry in statuses.iter() {
        let flags = entry.status();
        if flags.contains(Status::CONFLICTED) {
            continue;
        }
        if flags.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) && let Some(delta) = entry.head_to_index()
        {
            staged.push(file_from_delta(delta, false, false));
        }
        if flags.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
            // Staged + a stale index stat can also report WT_MODIFIED. Read
            // those candidates through one global CPU-sized pool, then retain
            // the exact existing filter/blob check on this same index snapshot.
            if flags.contains(Status::WT_MODIFIED)
                && !flags.intersects(
                    Status::WT_NEW
                        | Status::WT_DELETED
                        | Status::WT_RENAMED
                        | Status::WT_TYPECHANGE,
                )
                && let Ok(path) = entry.path()
            {
                let (size, value) = entry
                    .index_to_workdir()
                    .map(|delta| {
                        let size = delta.new_file().size();
                        (size, Some(file_from_delta(delta, false, false)))
                    })
                    .unwrap_or((0, None));
                pending_worktree_changes.push(PendingWorktreeChange {
                    path: PathBuf::from(path),
                    size,
                    value,
                });
                continue;
            }
            if let Some(delta) = entry.index_to_workdir() {
                changes.push(file_from_delta(
                    delta,
                    false,
                    flags.contains(Status::WT_NEW),
                ));
            }
        }
    }
    let workdir = repo.workdir();
    let max_files = WORKTREE_READ_POOL.width();
    let mut batch_start = 0;
    while batch_start < pending_worktree_changes.len() {
        let batch_end = pending_batch_end(
            &pending_worktree_changes,
            batch_start,
            max_files,
            MAX_PARALLEL_READ_BYTES,
        );
        let batch = &mut pending_worktree_changes[batch_start..batch_end];
        let paths = batch
            .iter()
            .map(|candidate| candidate.path.clone())
            .collect::<Vec<_>>();
        let contents = read_worktree_batch(workdir, &paths);
        for (candidate, contents) in batch.iter_mut().zip(contents) {
            let matches = contents.as_deref().is_some_and(|input| {
                if worktree_data_uses_external_filter(&repo, &candidate.path, input) {
                    return workdir
                        .and_then(|root| std::fs::read(root.join(&candidate.path)).ok())
                        .is_some_and(|fresh| {
                            worktree_data_matches_index(&repo, &index, &candidate.path, &fresh)
                        });
                }
                worktree_data_matches_index(&repo, &index, &candidate.path, input)
            });
            if !matches && let Some(value) = candidate.value.take() {
                changes.push(value);
            }
        }
        batch_start = batch_end;
    }
    let mut conflicts = BTreeMap::new();
    if let Ok(iter) = index.conflicts() {
        for conflict in iter.flatten() {
            let chosen = conflict
                .our
                .as_ref()
                .or(conflict.their.as_ref())
                .or(conflict.ancestor.as_ref());
            let Some(chosen) = chosen else {
                continue;
            };
            let path = String::from_utf8_lossy(&chosen.path).into_owned();
            if !paths.is_empty()
                && !paths
                    .iter()
                    .any(|selected| path == *selected || path.starts_with(&format!("{selected}/")))
            {
                continue;
            }
            conflicts.insert(path, conflict);
        }
    }
    // libgit2 can report the checked-out directory behind a conflicted Gitlink
    // as an additional untracked directory (for example `module/`). The
    // conflict entry is the authoritative parent-repository record; publishing
    // the directory duplicate makes the UI try to read a directory as a file.
    let conflicted_gitlink_paths: BTreeSet<String> = conflicts
        .iter()
        .filter_map(|(path, conflict)| {
            let is_gitlink = conflict
                .ancestor
                .as_ref()
                .or(conflict.our.as_ref())
                .or(conflict.their.as_ref())
                .is_some_and(|entry| index_mode_text(entry.mode) == "160000");
            is_gitlink.then(|| path.clone())
        })
        .collect();
    let is_gitlink_directory_duplicate = |value: &Value| {
        value
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|candidate| {
                conflicted_gitlink_paths
                    .iter()
                    .any(|path| candidate == format!("{path}/"))
            })
    };
    staged.retain(|value| !is_gitlink_directory_duplicate(value));
    changes.retain(|value| !is_gitlink_directory_duplicate(value));

    for (path, conflict) in conflicts {
        let (_, base_id, base_mode) = conflict
            .ancestor
            .as_ref()
            .map(conflict_entry)
            .unwrap_or_else(|| (path.clone(), zero_oid(40), "000000".to_owned()));
        let (_, ours_id, ours_mode) = conflict
            .our
            .as_ref()
            .map(conflict_entry)
            .unwrap_or_else(|| (path.clone(), zero_oid(40), "000000".to_owned()));
        let (_, incoming_id, incoming_mode) = conflict
            .their
            .as_ref()
            .map(conflict_entry)
            .unwrap_or_else(|| (path.clone(), zero_oid(40), "000000".to_owned()));
        let is_gitlink =
            base_mode == "160000" || ours_mode == "160000" || incoming_mode == "160000";
        staged.push(json!({
            "path": path,
            "status": "U",
            "oldObjectId": base_id,
            "newObjectId": ours_id,
            "oldMode": base_mode,
            "newMode": ours_mode,
            "gitlinkConflictBaseObjectId": base_id,
            "gitlinkConflictCurrentObjectId": ours_id,
            "gitlinkConflictIncomingObjectId": incoming_id,
            "isGitlink": is_gitlink,
            "isConflict": true,
        }));
        changes.push(json!({
            "path": path,
            "status": "U",
            "oldObjectId": ours_id,
            "newObjectId": zero_oid(ours_id.len()),
            "oldMode": ours_mode,
            "newMode": ours_mode,
            "gitlinkConflictBaseObjectId": base_id,
            "gitlinkConflictCurrentObjectId": ours_id,
            "gitlinkConflictIncomingObjectId": incoming_id,
            "isGitlink": is_gitlink,
            "isConflict": true,
        }));
    }
    let has_gitlink_result = staged.iter().chain(&changes).any(|file| {
        file.get("isGitlink")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let targets_gitlink = paths.iter().any(|path| {
        index
            .get_path(std::path::Path::new(path), 0)
            .is_some_and(|entry| index_mode_text(entry.mode) == "160000")
    });
    if skip_submodule_worktrees && (paths.is_empty() || has_gitlink_result || targets_gitlink) {
        append_submodule_pointer_changes(&repo, &paths, &mut staged, &mut changes)?;
    }
    let by_path = |left: &Value, right: &Value| {
        left.get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
    };
    staged.sort_by(by_path);
    changes.sort_by(by_path);
    Ok(json!({ "staged": staged, "changes": changes }))
}

pub fn has_changes(payload: &Value) -> NativeResult<Value> {
    let value = status(payload)?;
    let staged = value
        .get("staged")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    let changes = value
        .get("changes")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    Ok(Value::Bool(staged || changes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(size: u64) -> PendingWorktreeChange {
        PendingWorktreeChange {
            path: PathBuf::new(),
            size,
            value: None,
        }
    }

    #[test]
    fn pending_batches_respect_file_and_byte_limits() {
        let candidates = vec![candidate(10), candidate(20), candidate(40), candidate(100)];
        assert_eq!(pending_batch_end(&candidates, 0, 2, 64), 2);
        assert_eq!(pending_batch_end(&candidates, 2, 4, 64), 3);
        assert_eq!(pending_batch_end(&candidates, 3, 4, 64), 4);
        assert_eq!(pending_batch_end(&candidates, 0, 0, 0), 1);
    }
}
