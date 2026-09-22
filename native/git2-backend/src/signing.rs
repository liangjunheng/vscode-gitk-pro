use crate::support::{NativeResult, repository_root};
use git2::Repository;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_path(extension: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "vscode-gitk-{}-{stamp}.{extension}",
        std::process::id()
    ))
}

fn run_with_input(
    repo: &Repository,
    program: &str,
    args: &[String],
    input: &[u8],
) -> NativeResult<Vec<u8>> {
    let root = repository_root(repo)?;
    let mut child = Command::new(program)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动签名程序 {program}: {error}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "无法打开签名程序标准输入".to_owned())?
        .write_all(input)
        .map_err(|error| format!("写入签名程序失败: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待签名程序失败: {error}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

fn openpgp(repo: &Repository, content: &[u8], format: &str) -> NativeResult<String> {
    let config = repo.config().map_err(|error| error.to_string())?;
    let program_key = if format == "x509" {
        "gpg.x509.program"
    } else {
        "gpg.program"
    };
    let default_program = if format == "x509" { "gpgsm" } else { "gpg" };
    let program = config
        .get_string(program_key)
        .unwrap_or_else(|_| default_program.to_owned());
    let key = config.get_string("user.signingkey").ok();
    let mut args = vec![
        "--status-fd=2".to_owned(),
        "--armor".to_owned(),
        "--detach-sign".to_owned(),
    ];
    if let Some(key) = key {
        args.extend(["--local-user".to_owned(), key]);
    }
    let signature = run_with_input(repo, &program, &args, content)?;
    String::from_utf8(signature).map_err(|error| format!("签名程序返回的签名不是 UTF-8: {error}"))
}

fn ssh(repo: &Repository, content: &[u8]) -> NativeResult<String> {
    let config = repo.config().map_err(|error| error.to_string())?;
    let program = config
        .get_string("gpg.ssh.program")
        .unwrap_or_else(|_| "ssh-keygen".to_owned());
    let signing_key = config
        .get_string("user.signingkey")
        .map_err(|_| "使用 SSH 签名时必须配置 user.signingKey".to_owned())?;
    let input_path = temporary_path("commit");
    std::fs::write(&input_path, content).map_err(|error| error.to_string())?;
    let mut key_path = PathBuf::from(&signing_key);
    let mut temporary_key = None;
    if signing_key.starts_with("ssh-") {
        let path = temporary_path("pub");
        std::fs::write(&path, format!("{signing_key}\n")).map_err(|error| error.to_string())?;
        key_path = path.clone();
        temporary_key = Some(path);
    }
    let output = Command::new(&program)
        .args(["-Y", "sign", "-n", "git", "-f"])
        .arg(&key_path)
        .arg(&input_path)
        .current_dir(repository_root(repo)?)
        .output()
        .map_err(|error| format!("无法启动 SSH 签名程序 {program}: {error}"))?;
    let signature_path = PathBuf::from(format!("{}.sig", input_path.to_string_lossy()));
    let result = if output.status.success() {
        std::fs::read_to_string(&signature_path)
            .map_err(|error| format!("读取 SSH 签名失败: {error}"))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    };
    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&signature_path);
    if let Some(path) = temporary_key {
        let _ = std::fs::remove_file(path);
    }
    result
}

pub fn sign_commit(repo: &Repository, content: &str) -> NativeResult<Option<String>> {
    let config = repo.config().map_err(|error| error.to_string())?;
    if !config.get_bool("commit.gpgsign").unwrap_or(false) {
        return Ok(None);
    }
    let format = config
        .get_string("gpg.format")
        .unwrap_or_else(|_| "openpgp".to_owned())
        .to_ascii_lowercase();
    let signature = match format.as_str() {
        "ssh" => ssh(repo, content.as_bytes())?,
        "x509" => openpgp(repo, content.as_bytes(), "x509")?,
        _ => openpgp(repo, content.as_bytes(), "openpgp")?,
    };
    Ok(Some(signature))
}
