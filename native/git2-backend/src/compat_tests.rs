//! Differential tests: Git CLI is a test oracle only; production uses libgit2.
use super::*;
use git2::Repository;
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path, process::Command};

struct Fixture {
    dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        repo.config()
            .unwrap()
            .set_str("user.name", "Gitk Test")
            .unwrap();
        repo.config()
            .unwrap()
            .set_str("user.email", "gitk@example.com")
            .unwrap();
        repo.config()
            .unwrap()
            .set_str("core.autocrlf", "false")
            .unwrap();
        Self { dir }
    }
    fn root(&self) -> String {
        self.dir.path().to_string_lossy().into_owned()
    }
    fn payload(&self) -> Value {
        json!({"rootPath": self.root()})
    }
    fn write(&self, name: &str, contents: &str) {
        let file = self.dir.path().join(name);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(file, contents).unwrap();
    }
    fn git(&self, args: &[&str]) -> String {
        cli(self.dir.path(), args)
    }
    fn seed(&self) -> String {
        self.write("a.gkt", "original\n");
        self.git(&["add", "a.gkt"]);
        self.git(&["commit", "-m", "initial"]);
        self.git(&["rev-parse", "HEAD"]).trim().to_owned()
    }
    fn status_matches_cli(&self) {
        let root = self.root();
        let snapshot = status::status(&json!({"rootPath": root})).unwrap();
        let paths = |kind: &str| -> BTreeSet<String> {
            snapshot[kind]
                .as_array()
                .unwrap()
                .iter()
                .map(|file| file["path"].as_str().unwrap().to_owned())
                .collect()
        };
        let staged: BTreeSet<String> = self
            .git(&["diff", "--cached", "--name-only", "--no-renames"])
            .lines()
            .map(str::to_owned)
            .collect();
        let mut unstaged: BTreeSet<String> = self
            .git(&["diff", "--name-only", "--no-renames"])
            .lines()
            .map(str::to_owned)
            .collect();
        unstaged.extend(
            self.git(&["ls-files", "--others", "--exclude-standard"])
                .lines()
                .map(str::to_owned),
        );
        assert_eq!(
            paths("staged"),
            staged,
            "native staged status differs from git diff --cached"
        );
        assert_eq!(
            paths("changes"),
            unstaged,
            "native unstaged status differs from git diff and ls-files: {snapshot} / {}",
            self.git(&["status", "--porcelain=v1"])
        );
        assert_eq!(
            status::has_changes(&self.payload()).unwrap(),
            Value::Bool(!staged.is_empty() || !unstaged.is_empty())
        );
    }
}
fn cli(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Gitk Test")
        .env("GIT_AUTHOR_EMAIL", "gitk@example.com")
        .env("GIT_COMMITTER_NAME", "Gitk Test")
        .env("GIT_COMMITTER_EMAIL", "gitk@example.com")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn status_and_mutations_match_cli_with_partial_edits_deletions_and_ignored_files() {
    let f = Fixture::new();
    f.seed();
    f.write(".gitignore", "ignored.txt\n");
    f.write("ignored.txt", "ignore me\n");
    f.write("nested/new.txt", "new\n");
    f.write("a.gkt", "staged\n");
    f.status_matches_cli();
    mutations::stage(&json!({"rootPath": f.root(), "paths": ["a.gkt", "nested/new.txt"]})).unwrap();
    f.status_matches_cli();
    f.write("a.gkt", "unstaged\n");
    f.status_matches_cli();
    let scoped = status::status(&json!({"rootPath": f.root(), "paths": ["a.gkt"]})).unwrap();
    assert_eq!(scoped["staged"].as_array().unwrap().len(), 1);
    assert_eq!(scoped["changes"].as_array().unwrap().len(), 1);
    assert_eq!(
        mutations::tracked_paths(&json!({"rootPath": f.root(), "paths": ["a.gkt", "ignored.txt"]}))
            .unwrap(),
        json!(["a.gkt"])
    );
    mutations::restore_worktree(&json!({"rootPath": f.root(), "paths": ["a.gkt"]})).unwrap();
    f.status_matches_cli();
    mutations::unstage(&json!({"rootPath": f.root(), "paths": ["a.gkt", "nested/new.txt"]}))
        .unwrap();
    f.status_matches_cli();
    mutations::stage_all(&f.payload()).unwrap();
    f.status_matches_cli();
    assert!(!f.git(&["ls-files", "ignored.txt"]).contains("ignored.txt"));
    assert!(
        !mutations::index_changed_paths(&f.payload())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    mutations::restore_all(&f.payload()).unwrap();
    f.status_matches_cli();
}

#[test]
fn history_objects_branches_and_tags_match_cli() {
    let f = Fixture::new();
    let first = f.seed();
    f.write("a.gkt", "second\n");
    mutations::stage_all(&f.payload()).unwrap();
    let second = operations::commit(
        &json!({"rootPath": f.root(), "message": "subject\n\nbody\n", "amend": false}),
    )
    .unwrap()
    .as_str()
    .unwrap()
    .to_owned();
    assert_eq!(second, f.git(&["rev-parse", "HEAD"]).trim());
    assert_eq!(history::head(&f.payload()).unwrap()["hash"], second);
    let details =
        history::commit_details(&json!({"rootPath": f.root(), "hashes": [second]})).unwrap();
    assert_eq!(
        details[0]["message"]
            .as_str()
            .unwrap()
            .trim_end_matches('\n'),
        f.git(&["show", "-s", "--format=%B", "HEAD"])
            .trim_end_matches('\n')
    );
    let commits = history::commits(&json!({"rootPath": f.root(), "refs": [], "limit": 2})).unwrap();
    assert_eq!(commits.as_array().unwrap().len(), 2);
    assert_eq!(commits[0]["hash"], second);
    assert_eq!(
        history::range_commits(&json!({"rootPath": f.root(), "from": first, "to": second}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        history::commit_files(&json!({"rootPath": f.root(), "revision": second})).unwrap()[0]["path"],
        "a.gkt"
    );
    assert_eq!(
        history::changed_paths(&json!({"rootPath": f.root(), "before": first, "after": second}))
            .unwrap(),
        json!(["a.gkt"])
    );
    assert_eq!(
        objects::resolve_revision(&json!({"rootPath": f.root(), "specs": ["HEAD"]})).unwrap(),
        json!([second])
    );
    let oid = f.git(&["rev-parse", "HEAD:a.gkt"]);
    assert_eq!(
        objects::read_objects(&json!({"rootPath": f.root(), "objects": [oid.trim()]})).unwrap()
            [oid.trim()],
        "second\n"
    );
    operations::create_branch(&json!({"rootPath": f.root(), "name": "test", "revision": first}))
        .unwrap();
    operations::create_tag(&json!({"rootPath": f.root(), "name": "v1", "revision": second, "message": "tag annotation"})).unwrap();
    let branches = history::branches(&f.payload()).unwrap();
    assert!(
        branches["local"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["label"] == "test")
    );
    assert!(
        !history::repository_state(&f.payload()).unwrap()["refs"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        history::gitlink_paths(&json!({"rootPath": f.root(), "revision": "HEAD"})).unwrap(),
        json!([])
    );
    assert_eq!(
        history::gitlink_changes(&json!({"rootPath": f.root(), "before": first, "after": second}))
            .unwrap(),
        json!([])
    );
    assert_eq!(
        repository::config_get(&json!({"rootPath": f.root(), "key": "user.name"})).unwrap(),
        "Gitk Test"
    );
    assert!(
        repository::discover(&json!({"path": f.root()})).unwrap()["gitDir"]
            .as_str()
            .is_some()
    );
}

#[test]
fn checkout_reset_revert_and_cherry_pick_match_cli_outcomes() {
    let f = Fixture::new();
    let first = f.seed();
    f.write("a.gkt", "second\n");
    mutations::stage_all(&f.payload()).unwrap();
    let second = operations::commit(&json!({"rootPath": f.root(), "message": "second"}))
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let main = f.git(&["branch", "--show-current"]).trim().to_owned();
    operations::create_branch(&json!({"rootPath": f.root(), "name": "side", "revision": first}))
        .unwrap();
    remote::checkout_branch(&json!({"rootPath": f.root(), "branch": "side"})).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), first);
    assert_eq!(
        fs::read_to_string(f.dir.path().join("a.gkt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "original\n"
    );
    let picked =
        operations::cherry_pick(&json!({"rootPath": f.root(), "revision": second})).unwrap();
    assert_eq!(picked, f.git(&["rev-parse", "HEAD"]).trim());
    assert_eq!(f.git(&["show", "HEAD:a.gkt"]), "second\n");
    operations::revert(&json!({"rootPath": f.root(), "revision": "HEAD"})).unwrap();
    assert_eq!(f.git(&["show", "HEAD:a.gkt"]), "original\n");
    operations::checkout(&json!({"rootPath": f.root(), "revision": main})).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), second);
    operations::reset(&json!({"rootPath": f.root(), "revision": first, "mode": "soft"})).unwrap();
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), first);
    f.status_matches_cli();
    operations::reset(&json!({"rootPath": f.root(), "revision": first, "mode": "hard"})).unwrap();
    f.status_matches_cli();
}

#[test]
fn pull_must_not_overwrite_local_changes_to_same_file() {
    let origin = tempfile::tempdir().unwrap();
    Repository::init_bare(origin.path()).unwrap();
    let f = Fixture::new();
    f.git(&["remote", "add", "origin", &origin.path().to_string_lossy()]);
    let first = f.seed();
    remote::push(&json!({"rootPath": f.root(), "remote": "origin"})).unwrap();
    let branch = f.git(&["branch", "--show-current"]).trim().to_owned();
    cli(
        origin.path(),
        &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")],
    );
    let other = tempfile::tempdir().unwrap();
    cli(
        other.path(),
        &["clone", &origin.path().to_string_lossy(), "."],
    );
    cli(other.path(), &["config", "user.name", "Gitk Test"]);
    cli(other.path(), &["config", "user.email", "gitk@example.com"]);
    cli(other.path(), &["config", "core.autocrlf", "false"]);
    fs::write(other.path().join("a.gkt"), "remote edit\n").unwrap();
    cli(other.path(), &["add", "a.gkt"]);
    cli(other.path(), &["commit", "-m", "remote edit"]);
    cli(other.path(), &["push", "origin", "HEAD"]);
    f.write("a.gkt", "local edit\n");
    let result = remote::pull(&f.payload());
    assert!(
        result.is_err(),
        "Pull must reject a conflicting local edit: {result:?}"
    );
    assert_eq!(
        fs::read_to_string(f.dir.path().join("a.gkt")).unwrap(),
        "local edit\n"
    );
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), first);
    mutations::restore_worktree(&json!({"rootPath": f.root(), "paths": ["a.gkt"]})).unwrap();
    f.write("unrelated.gkt", "local untracked content\n");
    remote::pull(&f.payload()).unwrap();
    assert_eq!(
        fs::read_to_string(f.dir.path().join("unrelated.gkt")).unwrap(),
        "local untracked content\n"
    );
    assert_eq!(
        fs::read_to_string(f.dir.path().join("a.gkt")).unwrap(),
        "remote edit\n"
    );
    f.status_matches_cli();
    f.git(&["branch", &format!("--set-upstream-to=origin/{branch}")]);
    assert_eq!(
        history::ahead_behind(&f.payload()).unwrap(),
        json!({"ahead":0,"behind":0})
    );
    assert!(
        !history::push_branches(&f.payload())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn fast_forward_merge_preserves_local_edits_and_rejects_conflicting_index() {
    let f = Fixture::new();
    let first = f.seed();
    let main = f.git(&["branch", "--show-current"]).trim().to_owned();
    operations::create_branch(&json!({"rootPath": f.root(), "name": "topic", "revision": first}))
        .unwrap();
    remote::checkout_branch(&json!({"rootPath": f.root(), "branch": "topic"})).unwrap();
    f.write("a.gkt", "topic changed\n");
    mutations::stage_all(&f.payload()).unwrap();
    let other = operations::commit(&json!({"rootPath": f.root(), "message": "topic"}))
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    remote::checkout_branch(&json!({"rootPath": f.root(), "branch": main})).unwrap();
    f.write("a.gkt", "local edit\n");
    assert!(operations::merge(&json!({"rootPath": f.root(), "revision": "topic"})).is_err());
    assert_eq!(
        fs::read_to_string(f.dir.path().join("a.gkt")).unwrap(),
        "local edit\n"
    );
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), first);
    mutations::stage(&json!({"rootPath": f.root(), "paths": ["a.gkt"]})).unwrap();
    assert!(operations::merge(&json!({"rootPath": f.root(), "revision": "topic"})).is_err());
    assert_eq!(f.git(&["show", ":a.gkt"]), "local edit\n");
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), first);
    mutations::unstage(&json!({"rootPath": f.root(), "paths": ["a.gkt"]})).unwrap();
    mutations::restore_worktree(&json!({"rootPath": f.root(), "paths": ["a.gkt"]})).unwrap();
    f.write("unrelated.gkt", "staged\n");
    mutations::stage(&json!({"rootPath": f.root(), "paths": ["unrelated.gkt"]})).unwrap();
    // Git CLI allows unrelated staged files across a fast-forward merge.
    operations::merge(&json!({"rootPath": f.root(), "revision": "topic"})).unwrap();
    assert_eq!(f.git(&["show", ":unrelated.gkt"]), "staged\n");
    assert_eq!(f.git(&["rev-parse", "HEAD"]).trim(), other);
    assert_eq!(
        fs::read_to_string(f.dir.path().join("unrelated.gkt")).unwrap(),
        "staged\n"
    );
    f.status_matches_cli();
}

#[test]
fn fetch_and_push_match_cli_on_local_remote() {
    let origin = tempfile::tempdir().unwrap();
    Repository::init_bare(origin.path()).unwrap();
    let f = Fixture::new();
    let first = f.seed();
    f.git(&["remote", "add", "origin", &origin.path().to_string_lossy()]);
    let push_result = remote::push(&json!({"rootPath": f.root(), "remote": "origin"})).unwrap();
    assert_eq!(push_result["remote"], "origin");
    assert!(
        push_result["output"]
            .as_str()
            .is_some_and(|value| value.contains("->"))
    );
    let branch = f.git(&["branch", "--show-current"]).trim().to_owned();
    cli(
        origin.path(),
        &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")],
    );
    assert_eq!(cli(origin.path(), &["rev-parse", "HEAD"]).trim(), first);
    let other = tempfile::tempdir().unwrap();
    cli(
        other.path(),
        &["clone", &origin.path().to_string_lossy(), "."],
    );
    cli(other.path(), &["config", "user.name", "Gitk Test"]);
    cli(other.path(), &["config", "user.email", "gitk@example.com"]);
    cli(other.path(), &["config", "core.autocrlf", "false"]);
    fs::write(other.path().join("new.gkt"), "new\n").unwrap();
    cli(other.path(), &["add", "new.gkt"]);
    cli(other.path(), &["commit", "-m", "remote"]);
    cli(other.path(), &["push", "origin", "HEAD"]);
    remote::fetch(&json!({"rootPath": f.root(), "remote": "origin", "prune": true})).unwrap();
    let expected = cli(origin.path(), &["rev-parse", "HEAD"]);
    assert_eq!(
        f.git(&["rev-parse", &format!("origin/{branch}")]).trim(),
        expected.trim()
    );
    assert_eq!(
        history::branches(&f.payload()).unwrap()["remote"][0]["hash"],
        expected.trim()
    );
    assert!(
        !history::push_branches(&f.payload())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn submodule_gitlink_discovery_and_update_match_cli() {
    let child = Fixture::new();
    let child_head = child.seed();
    let f = Fixture::new();
    f.seed();
    f.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        &child.root(),
        "modules/child",
    ]);
    f.git(&["commit", "-am", "add submodule"]);
    let values = repository::submodules(&f.payload()).unwrap();
    assert_eq!(values.as_array().unwrap().len(), 1);
    assert_eq!(values[0]["path"], "modules/child");
    assert_eq!(
        submodule::index_gitlink(&json!({"rootPath": f.root(), "path": "modules/child"})).unwrap(),
        child_head
    );
    assert_eq!(
        history::gitlink_paths(&json!({"rootPath": f.root(), "revision": "HEAD"})).unwrap(),
        json!(["modules/child"])
    );
    assert_eq!(
        history::gitlink_changes(
            &json!({"rootPath": f.root(), "before": "HEAD~1", "after": "HEAD"})
        )
        .unwrap()
        .as_array()
        .unwrap()
        .len(),
        1
    );
    submodule::update(&json!({"rootPath": f.root(), "paths": ["modules/child"]})).unwrap();
    let child_path = f.dir.path().join("modules/child");
    assert_eq!(cli(&child_path, &["rev-parse", "HEAD"]).trim(), child_head);
    submodule::restore(&json!({"rootPath": child_path.to_string_lossy(), "revision": child_head}))
        .unwrap();
    assert!(
        !mutations::has_conflicts(&f.payload())
            .unwrap()
            .as_bool()
            .unwrap()
    );
}

#[test]
fn rebase_matches_cli_tip_and_keeps_unrelated_content() {
    let f = Fixture::new();
    let base = f.seed();
    operations::create_branch(&json!({"rootPath": f.root(), "name": "side", "revision": base}))
        .unwrap();
    let main = f.git(&["branch", "--show-current"]).trim().to_owned();
    f.write("main.gkt", "main\n");
    mutations::stage_all(&f.payload()).unwrap();
    let main_tip = operations::commit(&json!({"rootPath": f.root(), "message": "main"})).unwrap();
    remote::checkout_branch(&json!({"rootPath": f.root(), "branch": "side"})).unwrap();
    f.write("side.gkt", "side\n");
    mutations::stage_all(&f.payload()).unwrap();
    operations::commit(&json!({"rootPath": f.root(), "message": "side"})).unwrap();
    operations::rebase(&json!({"rootPath": f.root(), "revision": main})).unwrap();
    assert_eq!(
        f.git(&["rev-parse", "HEAD^1"]).trim(),
        main_tip.as_str().unwrap()
    );
    assert_eq!(f.git(&["show", "HEAD:side.gkt"]), "side\n");
    assert_eq!(f.git(&["show", "HEAD:main.gkt"]), "main\n");
    f.status_matches_cli();
}

#[test]
fn deletion_amend_and_mixed_reset_match_cli() {
    let f = Fixture::new();
    let first = f.seed();
    f.write("delete.gkt", "delete me\n");
    mutations::stage_all(&f.payload()).unwrap();
    operations::commit(&json!({"rootPath": f.root(), "message": "add delete target"})).unwrap();
    fs::remove_file(f.dir.path().join("delete.gkt")).unwrap();
    f.status_matches_cli();
    mutations::stage(&json!({"rootPath": f.root(), "paths": ["delete.gkt"]})).unwrap();
    f.status_matches_cli();
    assert_eq!(
        status::status(&f.payload()).unwrap()["staged"][0]["status"],
        "D"
    );
    mutations::unstage(&json!({"rootPath": f.root(), "paths": ["delete.gkt"]})).unwrap();
    f.status_matches_cli();
    mutations::restore_worktree(&json!({"rootPath": f.root(), "paths": ["delete.gkt"]})).unwrap();
    f.status_matches_cli();
    let former = f.git(&["rev-parse", "HEAD"]).trim().to_owned();
    f.write("a.gkt", "amended content\n");
    mutations::stage(&json!({"rootPath": f.root(), "paths": ["a.gkt"]})).unwrap();
    let amended = operations::commit(
        &json!({"rootPath": f.root(), "message": "new subject\n\nnew body", "amend": true}),
    )
    .unwrap();
    assert_ne!(amended, former);
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]).trim(), "2");
    assert_eq!(f.git(&["rev-parse", "HEAD~1"]).trim(), first);
    assert_eq!(
        f.git(&["show", "-s", "--format=%B", "HEAD"]).trim_end(),
        "new subject\n\nnew body"
    );
    f.write("a.gkt", "uncommitted\n");
    mutations::stage(&json!({"rootPath": f.root(), "paths": ["a.gkt"]})).unwrap();
    operations::reset(&json!({"rootPath": f.root(), "revision": first, "mode": "mixed"})).unwrap();
    f.status_matches_cli();
    assert_eq!(
        fs::read_to_string(f.dir.path().join("a.gkt")).unwrap(),
        "uncommitted\n"
    );
    operations::reset(&json!({"rootPath": f.root(), "revision": amended, "mode": "hard"})).unwrap();
    f.status_matches_cli();
}

#[test]
fn merge_of_diverged_branches_produces_the_same_tree_and_parents_as_git() {
    let f = Fixture::new();
    let base = f.seed();
    let main = f.git(&["branch", "--show-current"]).trim().to_owned();
    operations::create_branch(&json!({"rootPath": f.root(), "name": "topic", "revision": base}))
        .unwrap();
    f.write("main.gkt", "main\n");
    mutations::stage_all(&f.payload()).unwrap();
    let main_tip = operations::commit(&json!({"rootPath": f.root(), "message": "main"})).unwrap();
    remote::checkout_branch(&json!({"rootPath": f.root(), "branch": "topic"})).unwrap();
    f.write("topic.gkt", "topic\n");
    mutations::stage_all(&f.payload()).unwrap();
    let topic_tip = operations::commit(&json!({"rootPath": f.root(), "message": "topic"})).unwrap();
    remote::checkout_branch(&json!({"rootPath": f.root(), "branch": main})).unwrap();
    let merged = operations::merge(&json!({"rootPath": f.root(), "revision": "topic"})).unwrap();
    assert_eq!(merged["changed"], true);
    assert_eq!(
        f.git(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .skip(1)
            .collect::<Vec<_>>(),
        vec![main_tip.as_str().unwrap(), topic_tip.as_str().unwrap()]
    );
    assert_eq!(f.git(&["show", "HEAD:main.gkt"]), "main\n");
    assert_eq!(f.git(&["show", "HEAD:topic.gkt"]), "topic\n");
    f.status_matches_cli();
}

#[test]
fn renamed_and_deleted_files_keep_cli_status_semantics() {
    let f = Fixture::new();
    f.seed();
    fs::rename(f.dir.path().join("a.gkt"), f.dir.path().join("renamed.gkt")).unwrap();
    let before = status::status(&f.payload()).unwrap();
    assert!(
        before["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "renamed.gkt")
    );
    mutations::stage(&json!({"rootPath": f.root(), "paths": ["a.gkt", "renamed.gkt"]})).unwrap();
    let staged = status::status(&f.payload()).unwrap();
    assert!(
        staged["staged"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "renamed.gkt" && file["status"] == "R")
    );
    assert!(staged["changes"].as_array().unwrap().is_empty());
    assert!(
        f.git(&["diff", "--cached", "--name-status"])
            .starts_with("R100\ta.gkt\trenamed.gkt")
    );
    let changed = mutations::index_changed_paths(&f.payload()).unwrap();
    assert!(
        changed
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path == "a.gkt")
    );
    assert!(
        changed
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path == "renamed.gkt")
    );
}

#[test]
fn conflicting_merge_reports_the_index_conflict_without_moving_head() {
    let f = Fixture::new();
    let base = f.seed();
    let main = f.git(&["branch", "--show-current"]).trim().to_owned();
    operations::create_branch(&json!({"rootPath": f.root(), "name": "topic", "revision": base}))
        .unwrap();
    f.write("a.gkt", "main edit\n");
    mutations::stage_all(&f.payload()).unwrap();
    let before = operations::commit(&json!({"rootPath": f.root(), "message": "main"})).unwrap();
    remote::checkout_branch(&json!({"rootPath": f.root(), "branch": "topic"})).unwrap();
    f.write("a.gkt", "other edit\n");
    mutations::stage_all(&f.payload()).unwrap();
    operations::commit(&json!({"rootPath": f.root(), "message": "other"})).unwrap();
    remote::checkout_branch(&json!({"rootPath": f.root(), "branch": main})).unwrap();
    assert!(operations::merge(&json!({"rootPath": f.root(), "revision": "topic"})).is_err());
    assert_eq!(
        f.git(&["rev-parse", "HEAD"]).trim(),
        before.as_str().unwrap()
    );
    assert_eq!(mutations::has_conflicts(&f.payload()).unwrap(), true);
    let state = status::status(&f.payload()).unwrap();
    assert!(
        state["staged"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["isConflict"] == true)
    );
}
