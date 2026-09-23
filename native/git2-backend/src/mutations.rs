use crate::filters::{apply_clean_filters, apply_smudge_filters};
use crate::support::{NativeResult, format_git_error, open_repository, string_arg, string_array};
use git2::{
    DiffFindOptions, DiffOptions, IndexAddOption, ResetType, StatusOptions, build::CheckoutBuilder,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;

fn worktree_changed_paths(repo: &git2::Repository) -> NativeResult<Vec<String>> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_unmodified(false)
        .exclude_submodules(false);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(format_git_error)?;
    let mut paths = BTreeSet::new();
    for entry in statuses.iter() {
        if let Ok(path) = entry.path() {
            paths.insert(path.replace('\\', "/"));
        }
    }
    Ok(paths.into_iter().collect())
}

pub fn stage(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let paths = string_array(payload, "paths")?;
    if paths.is_empty() {
        return Ok(Value::Null);
    }
    let repo = open_repository(root_path)?;
    let root = crate::support::repository_root(&repo)?;
    let mut index = repo.index().map_err(format_git_error)?;
    let (existing, deleted): (Vec<&String>, Vec<&String>) = paths
        .iter()
        .partition(|value| std::fs::symlink_metadata(root.join(value)).is_ok());
    for value in existing {
        index.add_path(Path::new(value)).map_err(format_git_error)?;
    }
    for value in deleted {
        let path = Path::new(value);
        if index.get_path(path, 0).is_some() {
            index.remove_path(path).map_err(format_git_error)?;
        }
    }
    apply_clean_filters(&repo, &mut index, &paths)?;
    index.write().map_err(format_git_error)?;
    Ok(Value::Null)
}

pub fn stage_all(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let paths = worktree_changed_paths(&repo)?;
    let mut index = repo.index().map_err(format_git_error)?;
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .map_err(format_git_error)?;
    index.update_all(["*"], None).map_err(format_git_error)?;
    apply_clean_filters(&repo, &mut index, &paths)?;
    index.write().map_err(format_git_error)?;
    Ok(Value::Null)
}

pub fn unstage(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let paths = string_array(payload, "paths")?;
    if paths.is_empty() {
        return Ok(Value::Null);
    }
    let repo = open_repository(root_path)?;
    match repo.revparse_single("HEAD") {
        Ok(target) => repo
            .reset_default(Some(&target), paths.iter().map(String::as_str))
            .map_err(format_git_error)?,
        Err(_) => {
            let mut index = repo.index().map_err(format_git_error)?;
            index
                .remove_all(paths.iter().map(String::as_str), None)
                .map_err(format_git_error)?;
            index.write().map_err(format_git_error)?;
        }
    }
    Ok(Value::Null)
}

pub fn restore_worktree(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let paths = string_array(payload, "paths")?;
    if paths.is_empty() {
        return Ok(Value::Null);
    }
    let repo = open_repository(root_path)?;
    // libgit2 expands a checkout containing multiple pathspecs into a wider
    // worktree scan on Windows. Restore each selected file independently so
    // unrelated ignored build artifacts cannot block the operation.
    for path in &paths {
        let mut checkout = CheckoutBuilder::new();
        checkout
            .force()
            .recreate_missing(true)
            .update_index(false)
            .path(path);
        repo.checkout_index(None, Some(&mut checkout))
            .map_err(format_git_error)?;
    }
    apply_smudge_filters(&repo, &paths)?;
    Ok(Value::Null)
}

pub fn restore_all(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let paths = worktree_changed_paths(&repo)?;
    if let Ok(target) = repo.revparse_single("HEAD") {
        repo.reset(&target, ResetType::Mixed, None)
            .map_err(format_git_error)?;
    }
    let mut checkout = CheckoutBuilder::new();
    checkout.force().recreate_missing(true).update_index(false);
    repo.checkout_index(None, Some(&mut checkout))
        .map_err(format_git_error)?;
    apply_smudge_filters(&repo, &paths)?;
    Ok(Value::Null)
}

pub fn tracked_paths(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let paths = string_array(payload, "paths")?;
    let repo = open_repository(root_path)?;
    let index = repo.index().map_err(format_git_error)?;
    let values = paths
        .into_iter()
        .filter(|path| index.get_path(Path::new(path), 0).is_some())
        .map(Value::String)
        .collect();
    Ok(Value::Array(values))
}

pub fn index_changed_paths(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let mut options = DiffOptions::new();
    options
        .include_untracked(false)
        .include_typechange(true)
        .recurse_untracked_dirs(false);
    let mut diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut options))
        .map_err(format_git_error)?;
    let mut find = DiffFindOptions::new();
    find.renames(true).copies(true).copies_from_unmodified(true);
    let _ = diff.find_similar(Some(&mut find));
    let mut paths = BTreeSet::new();
    for delta in diff.deltas() {
        if let Some(path) = delta.old_file().path() {
            paths.insert(path.to_string_lossy().replace('\\', "/"));
        }
        if let Some(path) = delta.new_file().path() {
            paths.insert(path.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(json!(paths))
}

pub fn has_conflicts(payload: &Value) -> NativeResult<Value> {
    let root_path = string_arg(payload, "rootPath")?;
    let repo = open_repository(root_path)?;
    let index = repo.index().map_err(format_git_error)?;
    Ok(Value::Bool(index.has_conflicts()))
}
