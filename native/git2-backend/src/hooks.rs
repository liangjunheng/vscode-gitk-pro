use crate::support::{NativeResult, format_git_error, repository_root};
use git2::Repository;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

fn hook_directory(repo: &Repository) -> NativeResult<PathBuf> {
    let configured = repo
        .config()
        .ok()
        .and_then(|config| config.get_string("core.hooksPath").ok());
    if let Some(value) = configured {
        let path = PathBuf::from(value);
        return if path.is_absolute() {
            Ok(path)
        } else {
            Ok(repository_root(repo)?.join(path))
        };
    }
    Ok(repo.commondir().join("hooks"))
}

fn execute(mut command: Command, stdin: &[u8]) -> std::io::Result<Output> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if !stdin.is_empty()
        && let Some(input) = child.stdin.as_mut()
    {
        input.write_all(stdin)?;
    }
    child.wait_with_output()
}

fn run_program(
    repo: &Repository,
    hook: &Path,
    args: &[String],
    stdin: &[u8],
) -> NativeResult<Output> {
    let root = repository_root(repo)?;
    let configure = |command: &mut Command| {
        command
            .current_dir(&root)
            .env("GIT_DIR", repo.path())
            .env("GIT_WORK_TREE", &root);
    };
    let mut direct = Command::new(hook);
    direct.args(args);
    configure(&mut direct);
    match execute(direct, stdin) {
        Ok(output) => Ok(output),
        Err(direct_error) => {
            #[cfg(windows)]
            let mut shell = {
                let mut value = Command::new("sh");
                value.arg(hook);
                value
            };
            #[cfg(not(windows))]
            let mut shell = {
                let mut value = Command::new("/bin/sh");
                value.arg(hook);
                value
            };
            shell.args(args);
            configure(&mut shell);
            execute(shell, stdin).map_err(|shell_error| {
                format!(
                    "无法运行 hook {}: {direct_error}; {shell_error}",
                    hook.display()
                )
            })
        }
    }
}

pub fn run_hook(repo: &Repository, name: &str, args: &[String], stdin: &[u8]) -> NativeResult<()> {
    let hook = hook_directory(repo)?.join(name);
    if !hook.is_file() {
        return Ok(());
    }
    let output = run_program(repo, &hook, args, stdin)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("hook {name} 失败: {}", output.status)
    })
}

pub fn prepare_commit_message(
    repo: &Repository,
    message: &str,
    amend: bool,
    old_head: Option<git2::Oid>,
) -> NativeResult<String> {
    run_hook(repo, "pre-commit", &[], &[])?;
    let message_path = repo.path().join("COMMIT_EDITMSG");
    std::fs::write(&message_path, message)
        .map_err(|error| format!("写入 COMMIT_EDITMSG 失败: {error}"))?;
    let mut prepare_args = vec![message_path.to_string_lossy().into_owned()];
    if amend {
        prepare_args.push("commit".to_owned());
        if let Some(oid) = old_head {
            prepare_args.push(oid.to_string());
        }
    } else {
        prepare_args.push("message".to_owned());
    }
    run_hook(repo, "prepare-commit-msg", &prepare_args, &[])?;
    run_hook(
        repo,
        "commit-msg",
        &[message_path.to_string_lossy().into_owned()],
        &[],
    )?;
    std::fs::read_to_string(&message_path)
        .map_err(|error| format!("读取 COMMIT_EDITMSG 失败: {error}"))
}

pub fn post_commit(
    repo: &Repository,
    amend: bool,
    old_head: Option<git2::Oid>,
    new_head: git2::Oid,
) -> NativeResult<()> {
    run_hook(repo, "post-commit", &[], &[])?;
    if amend && let Some(old) = old_head {
        run_hook(
            repo,
            "post-rewrite",
            &["amend".to_owned()],
            format!("{old} {new_head}\n").as_bytes(),
        )?;
    }
    Ok(())
}

pub fn update_head(repo: &Repository, oid: git2::Oid, message: &str) -> NativeResult<()> {
    match repo.head() {
        Ok(mut head) if head.is_branch() => {
            head.set_target(oid, message).map_err(format_git_error)?;
        }
        Ok(_) => {
            repo.set_head_detached(oid).map_err(format_git_error)?;
        }
        Err(_) => {
            let symbolic = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|head| head.symbolic_target().ok().flatten().map(str::to_owned));
            if let Some(reference) = symbolic {
                repo.reference(&reference, oid, true, message)
                    .map_err(format_git_error)?;
                repo.set_head(&reference).map_err(format_git_error)?;
            } else {
                repo.set_head_detached(oid).map_err(format_git_error)?;
            }
        }
    }
    Ok(())
}
