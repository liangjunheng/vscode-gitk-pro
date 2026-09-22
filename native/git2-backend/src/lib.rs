mod filters;
mod history;
mod hooks;
mod mutations;
mod objects;
mod operations;
mod remote;
mod repository;
mod signing;
mod status;
mod submodule;
mod support;

use napi::{Env, Error, Result, Task, bindgen_prelude::AsyncTask};
use napi_derive::napi;
use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

static REPOSITORY_LOCKS: Lazy<Mutex<HashMap<String, Arc<RwLock<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn repository_lock(payload: &Value) -> Option<Arc<RwLock<()>>> {
    let path = payload
        .get("rootPath")
        .or_else(|| payload.get("path"))
        .and_then(Value::as_str)?;
    let normalized = path.replace('\\', "/").trim_end_matches('/').to_owned();
    #[cfg(windows)]
    let normalized = normalized.to_lowercase();
    Some(
        REPOSITORY_LOCKS
            .lock()
            .entry(normalized)
            .or_insert_with(|| Arc::new(RwLock::new(())))
            .clone(),
    )
}

fn is_mutating_operation(operation: &str) -> bool {
    matches!(
        operation,
        "stage"
            | "stageAll"
            | "unstage"
            | "restoreWorktree"
            | "restoreAll"
            | "commit"
            | "createBranch"
            | "createTag"
            | "checkout"
            | "reset"
            | "merge"
            | "cherryPick"
            | "revert"
            | "rebase"
            | "fetch"
            | "push"
            | "pull"
            | "checkoutBranch"
            | "updateSubmodules"
            | "restoreSubmodule"
            | "indexGitlink"
    )
}

fn dispatch_operation(operation: &str, payload: &Value) -> std::result::Result<Value, String> {
    match operation {
        "discover" => repository::discover(payload),
        "configGet" => repository::config_get(payload),
        "submodules" => repository::submodules(payload),
        "readObjects" => objects::read_objects(payload),
        "resolveRevision" => objects::resolve_revision(payload),
        "status" => status::status(payload),
        "hasChanges" => status::has_changes(payload),
        "branches" => history::branches(payload),
        "head" => history::head(payload),
        "commits" => history::commits(payload),
        "commitFiles" => history::commit_files(payload),
        "gitlinkPaths" => history::gitlink_paths(payload),
        "aheadBehind" => history::ahead_behind(payload),
        "commitDetails" => history::commit_details(payload),
        "rangeCommits" => history::range_commits(payload),
        "repositoryState" => history::repository_state(payload),
        "changedPaths" => history::changed_paths(payload),
        "gitlinkChanges" => history::gitlink_changes(payload),
        "pushBranches" => history::push_branches(payload),
        "stage" => mutations::stage(payload),
        "stageAll" => mutations::stage_all(payload),
        "unstage" => mutations::unstage(payload),
        "restoreWorktree" => mutations::restore_worktree(payload),
        "restoreAll" => mutations::restore_all(payload),
        "trackedPaths" => mutations::tracked_paths(payload),
        "indexChangedPaths" => mutations::index_changed_paths(payload),
        "hasConflicts" => mutations::has_conflicts(payload),
        "commit" => operations::commit(payload),
        "createBranch" => operations::create_branch(payload),
        "createTag" => operations::create_tag(payload),
        "checkout" => operations::checkout(payload),
        "reset" => operations::reset(payload),
        "merge" => operations::merge(payload),
        "cherryPick" => operations::cherry_pick(payload),
        "revert" => operations::revert(payload),
        "rebase" => operations::rebase(payload),
        "fetch" => remote::fetch(payload),
        "push" => remote::push(payload),
        "pull" => remote::pull(payload),
        "checkoutBranch" => remote::checkout_branch(payload),
        "updateSubmodules" => submodule::update(payload),
        "restoreSubmodule" => submodule::restore(payload),
        "indexGitlink" => submodule::index_gitlink(payload),
        operation => Err(format!("不支持的 libgit2 操作: {operation}")),
    }
}

pub struct InvokeTask {
    operation: String,
    payload: String,
}

impl Task for InvokeTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let payload: Value = serde_json::from_str(&self.payload)
            .map_err(|error| Error::from_reason(format!("参数 JSON 无效: {error}")))?;
        let result = if let Some(lock) = repository_lock(&payload) {
            if is_mutating_operation(&self.operation) {
                let _guard = lock.write();
                dispatch_operation(&self.operation, &payload)
            } else {
                let _guard = lock.read();
                dispatch_operation(&self.operation, &payload)
            }
        } else {
            dispatch_operation(&self.operation, &payload)
        }
        .map_err(Error::from_reason)?;
        serde_json::to_string(&result).map_err(|error| Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn invoke(operation: String, payload: String) -> AsyncTask<InvokeTask> {
    AsyncTask::new(InvokeTask { operation, payload })
}

#[napi]
pub fn libgit2_version() -> String {
    let (major, minor, patch) = git2::Version::get().libgit2_version();
    format!("{major}.{minor}.{patch}")
}

#[napi]
pub fn binding_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use serde_json::json;
    use std::fs;

    fn fixture() -> (tempfile::TempDir, Repository) {
        let directory = tempfile::tempdir().unwrap();
        let repo = Repository::init(directory.path()).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Gitk Test").unwrap();
        config.set_str("user.email", "gitk@example.com").unwrap();
        drop(config);
        (directory, repo)
    }

    #[test]
    fn stage_commit_and_read_multiline_message() {
        let (directory, _repo) = fixture();
        fs::write(directory.path().join("file.txt"), "first\r\nsecond\r\n").unwrap();
        let root = directory.path().to_string_lossy();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        let oid = operations::commit(&json!({
            "rootPath": root,
            "message": "subject\n\nbody line 1\nbody line 2",
            "amend": false
        }))
        .unwrap();
        let values =
            history::commit_details(&json!({ "rootPath": root, "hashes": [oid] })).unwrap();
        assert_eq!(values[0]["message"], "subject\n\nbody line 1\nbody line 2");
        assert_eq!(
            status::has_changes(&json!({ "rootPath": root })).unwrap(),
            Value::Bool(false)
        );
    }

    #[test]
    fn stage_unstage_and_partial_edits_keep_separate_sections() {
        let (directory, repo) = fixture();
        repo.config()
            .unwrap()
            .set_str("core.autocrlf", "true")
            .unwrap();
        let root = directory.path().to_string_lossy();
        let file = directory.path().join("file.txt");
        fs::write(&file, "initial\r\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        operations::commit(&json!({ "rootPath": root, "message": "initial", "amend": false }))
            .unwrap();
        fs::write(&file, "staged\r\n").unwrap();
        mutations::stage(&json!({ "rootPath": root, "paths": ["file.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 0);

        // The index and worktree really differ only after another edit.
        fs::write(&file, "unstaged\r\n").unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);

        mutations::unstage(&json!({ "rootPath": root, "paths": ["file.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 0);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn discard_only_unstaged_half_of_the_same_file() {
        let (directory, repo) = fixture();
        repo.config()
            .unwrap()
            .set_str("core.autocrlf", "true")
            .unwrap();
        let root = directory.path().to_string_lossy();
        let file = directory.path().join("file.txt");
        fs::write(&file, "original\r\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        operations::commit(&json!({ "rootPath": root, "message": "initial", "amend": false }))
            .unwrap();
        fs::write(&file, "staged\r\n").unwrap();
        mutations::stage(&json!({ "rootPath": root, "paths": ["file.txt"] })).unwrap();
        fs::write(&file, "unstaged\r\n").unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);

        mutations::restore_worktree(&json!({ "rootPath": root, "paths": ["file.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 0);
        assert_eq!(
            fs::read_to_string(&file).unwrap().replace("\r\n", "\n"),
            "staged\n"
        );
    }

    #[test]
    fn multi_file_stage_unstage_and_restore_update_the_right_lists() {
        let (directory, _repo) = fixture();
        let root = directory.path().to_string_lossy();
        for name in ["one.txt", "two.txt"] {
            fs::write(directory.path().join(name), "initial\n").unwrap();
        }
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        operations::commit(&json!({ "rootPath": root, "message": "initial", "amend": false }))
            .unwrap();
        for name in ["one.txt", "two.txt", "new.txt"] {
            fs::write(directory.path().join(name), "changed\n").unwrap();
        }
        let before = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(
            before["changes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|file| file["path"] == "new.txt")
                .unwrap()["isUntracked"],
            true
        );
        mutations::stage(&json!({ "rootPath": root, "paths": ["one.txt", "new.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);

        mutations::unstage(&json!({ "rootPath": root, "paths": ["one.txt", "new.txt"] })).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["staged"].as_array().unwrap().len(), 0);
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 3);
        assert_eq!(
            snapshot["changes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|file| file["path"] == "new.txt")
                .unwrap()["isUntracked"],
            true
        );

        mutations::restore_worktree(&json!({ "rootPath": root, "paths": ["one.txt", "two.txt"] }))
            .unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["changes"][0]["path"], "new.txt");
    }

    #[test]
    fn status_read_does_not_rewrite_index() {
        let (directory, repo) = fixture();
        let root = directory.path().to_string_lossy();
        fs::write(directory.path().join("file.txt"), "first\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        operations::commit(&json!({ "rootPath": root, "message": "initial", "amend": false }))
            .unwrap();
        fs::write(directory.path().join("file.txt"), "second\n").unwrap();
        let index = repo.path().join("index");
        let before = fs::read(&index).unwrap();
        let snapshot = status::status(&json!({ "rootPath": root })).unwrap();
        assert_eq!(snapshot["changes"].as_array().unwrap().len(), 1);
        assert_eq!(fs::read(index).unwrap(), before);
    }

    #[test]
    fn branch_checkout_and_revert_work_without_git_cli() {
        let (directory, _repo) = fixture();
        let root = directory.path().to_string_lossy();
        fs::write(directory.path().join("file.txt"), "one\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        let first =
            operations::commit(&json!({ "rootPath": root, "message": "first", "amend": false }))
                .unwrap();
        fs::write(directory.path().join("file.txt"), "two\n").unwrap();
        mutations::stage_all(&json!({ "rootPath": root })).unwrap();
        let second =
            operations::commit(&json!({ "rootPath": root, "message": "second", "amend": false }))
                .unwrap();
        operations::create_branch(&json!({ "rootPath": root, "name": "topic", "revision": first }))
            .unwrap();
        operations::checkout(&json!({ "rootPath": root, "revision": "topic", "detach": false }))
            .unwrap();
        assert_eq!(
            fs::read_to_string(directory.path().join("file.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "one\n"
        );
        operations::checkout(&json!({ "rootPath": root, "revision": second, "detach": true }))
            .unwrap();
        operations::revert(&json!({ "rootPath": root, "revision": second })).unwrap();
        assert_eq!(
            fs::read_to_string(directory.path().join("file.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "one\n"
        );
    }
}
#[cfg(test)]
mod compat_tests;
