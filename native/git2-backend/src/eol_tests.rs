use crate::{mutations, status};
use git2::Repository;
use serde_json::json;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> String {
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
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn native_change_paths(root: &Path) -> BTreeSet<String> {
    status::status(&json!({"rootPath": root.to_string_lossy()})).unwrap()["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["path"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn status_follows_checkout_eol_rules_without_hiding_noncanonical_files() {
    let directory = tempfile::tempdir().unwrap();
    let repo = Repository::init(directory.path()).unwrap();
    {
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Gitk Test").unwrap();
        config.set_str("user.email", "gitk@example.com").unwrap();
        config.set_str("core.autocrlf", "true").unwrap();
    }
    fs::write(
        directory.path().join(".gitattributes"),
        ".gitattributes text eol=lf\nlf.gkt text eol=lf\ncrlf.gkt text eol=crlf\n",
    )
    .unwrap();
    fs::write(directory.path().join("lf.gkt"), "base\n").unwrap();
    fs::write(directory.path().join("crlf.gkt"), "base\r\n").unwrap();
    git(
        directory.path(),
        &["add", ".gitattributes", "lf.gkt", "crlf.gkt"],
    );
    git(directory.path(), &["commit", "-m", "base"]);
    assert!(native_change_paths(directory.path()).is_empty());

    // Both files still clean-filter to their index blobs, but their raw
    // worktree representation violates the explicit checkout EOL rule.
    fs::write(directory.path().join("lf.gkt"), "base\r\n").unwrap();
    fs::write(directory.path().join("crlf.gkt"), "base\n").unwrap();
    let native = native_change_paths(directory.path());
    assert_eq!(
        native,
        BTreeSet::from(["crlf.gkt".to_owned(), "lf.gkt".to_owned()])
    );
    let cli: BTreeSet<String> = git(directory.path(), &["status", "--porcelain=v1"])
        .lines()
        .map(|line| line[3..].to_owned())
        .collect();
    assert_eq!(native, cli);

    mutations::restore_worktree(&json!({
        "rootPath": directory.path().to_string_lossy(),
        "paths": ["lf.gkt", "crlf.gkt"]
    }))
    .unwrap();
    assert_eq!(
        fs::read(directory.path().join("lf.gkt")).unwrap(),
        b"base\n"
    );
    assert_eq!(
        fs::read(directory.path().join("crlf.gkt")).unwrap(),
        b"base\r\n"
    );
    assert!(native_change_paths(directory.path()).is_empty());

    // A stat-only rewrite in the canonical representation must remain hidden.
    std::thread::sleep(std::time::Duration::from_millis(1_100));
    let lf = fs::read(directory.path().join("lf.gkt")).unwrap();
    let crlf = fs::read(directory.path().join("crlf.gkt")).unwrap();
    fs::write(directory.path().join("lf.gkt"), lf).unwrap();
    fs::write(directory.path().join("crlf.gkt"), crlf).unwrap();
    assert!(native_change_paths(directory.path()).is_empty());
}
