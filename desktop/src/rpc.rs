//! 前后端桥
//!
//! 界面只认识三个方法（snapshot / action / setting），这条纪律沿用旧版：
//! 加一个 QQ 能力不该新增 IPC 通道，后端才是权威。
//!
//! 因此这里只暴露：
//!   · ling_invoke       —— 白名单 method 转发给后端
//!   · ling_restart_backend
//!   · ling_pick_file    —— 纯界面操作，只拿路径，不参与授权
//!   · ling_meta         —— 只读环境信息
//!   · ling_open_url     —— 打开网址，**只放行白名单主机**
//!   · ling_spawn        —— 启动 SnowLuma，**只放行它自己的 index.mjs**

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::backend::{Backend, RpcError};

const ALLOWED_METHODS: [&str; 3] = ["snapshot", "action", "setting"];

/// `ling_open_url` 允许打开的主机。
///
/// 这个接口会把地址交给系统浏览器，等于"替用户点一个链接"。
/// 不设白名单的话，任何注入到界面的字符串都能变成任意网址 ——
/// 包括 `file:` 这类本地协议。所以只认下面这些站点，且必须是 https。
const ALLOWED_URL_HOSTS: [&str; 8] = [
    "nodejs.org",
    "github.com",
    "objects.githubusercontent.com",
    "api.github.com",
    "snowluma.com",
    "www.snowluma.com",
    "127.0.0.1",
    "localhost",
];

/// 判断一个 URL 是否允许被打开。
///
/// 刻意实现得很窄：只接受 `http://127.0.0.1`、`http://localhost`
/// 和 https 的白名单主机；其余一律拒绝。
fn url_allowed(raw: &str) -> bool {
    let Some(rest) = raw.strip_prefix("http://").or_else(|| raw.strip_prefix("https://")) else {
        return false;
    };
    let is_http = raw.starts_with("http://");
    // 去掉 path/query，取 host[:port]
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let host = authority.split(':').next().unwrap_or("").to_ascii_lowercase();

    // 本地控制台允许明文 http，其余必须 https
    let local = host == "127.0.0.1" || host == "localhost";
    if local {
        return true;
    }
    if is_http {
        return false;
    }
    ALLOWED_URL_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// 打开一个外部网址。
///
/// 只允许 http(s)，且主机要在白名单里（见 `url_allowed`）。
#[tauri::command]
pub fn ling_open_url(url: String) -> Value {
    if !url_allowed(&url) {
        return json!({
            "ok": false,
            "code": "E1004",
            "message": format!("不允许打开该地址：{url}")
        });
    }
    #[cfg(windows)]
    {
        // 用 cmd /c start 而不是 ShellExecuteW：无需额外依赖，且能正确处理默认浏览器。
        // 空字符串是 start 的"窗口标题"占位，不能省（否则带引号的 URL 会被当标题）。
        use std::os::windows::process::CommandExt;
        let r = std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(0x0800_0000)
            .spawn();
        return match r {
            Ok(_) => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "code": "E1011", "message": format!("打开失败：{e}") }),
        };
    }
    #[cfg(not(windows))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        match std::process::Command::new(opener).arg(&url).spawn() {
            Ok(_) => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "code": "E1011", "message": format!("打开失败：{e}") }),
        }
    }
}

/// 启动 SnowLuma。
///
/// 只接受一个目录参数，并要求该目录里**确实有 index.mjs**：
/// 否则这个接口就变成"用任意参数启动任意程序"。
/// 用 `node index.mjs`（而不是 launcher.bat）是为了不弹出控制台窗口。
#[tauri::command]
pub async fn ling_spawn_snowluma(dir: String) -> Value {
    let dir_path = std::path::PathBuf::from(&dir);
    let entry = dir_path.join("index.mjs");
    if !entry.is_file() {
        return json!({
            "ok": false,
            "code": "E1004",
            "message": format!("这个目录不是 SnowLuma：{}\n              （缺少 index.mjs）", dir)
        });
    }

    // SnowLuma 自带 node.exe 时优先用它：它自检要求 >=24，用系统的可能不匹配。
    let bundled = dir_path.join("node.exe");
    let node = if bundled.is_file() {
        bundled.to_string_lossy().to_string()
    } else {
        std::env::var("LING_NODE").unwrap_or_else(|_| "node".to_string())
    };

    let mut cmd = std::process::Command::new(&node);
    cmd.arg("index.mjs").current_dir(&dir_path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 不弹控制台
        cmd.creation_flags(0x0800_0000);
    }

    match cmd.spawn() {
        Ok(child) => json!({
            "ok": true,
            "pid": child.id(),
            "message": format!("已启动 SnowLuma（PID {}），等它完成注入后点「控制台」", child.id())
        }),
        Err(e) => json!({
            "ok": false,
            "code": "E1011",
            "message": format!("启动失败：{e}")
        }),
    }
}


/// 模型目录、连接测试、多阶段能力探测各有自己的网络预算，
/// 不能被默认 15 秒先截断。
fn timeout_for(payload: &Value) -> u64 {
    let name = payload
        .get("action")
        .or_else(|| payload.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if name.starts_with("llm.") || name.starts_with("model.") {
        330_000
    } else {
        15_000
    }
}

fn error_value(err: RpcError) -> Value {
    json!({ "ok": false, "code": err.code, "message": err.message })
}

/// 阻塞请求放到后台线程，避免卡住 WebView 的 IPC 线程。
async fn call(
    backend: Backend,
    method: String,
    payload: Value,
    timeout: u64,
) -> Result<Value, RpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        backend.request_blocking(&method, payload, timeout)
    })
    .await
    .map_err(|e| RpcError {
        code: Some("E1009".into()),
        message: format!("请求线程异常：{e}"),
    })?
}

#[tauri::command]
pub async fn ling_invoke(
    backend: State<'_, Backend>,
    method: String,
    payload: Option<Value>,
) -> Result<Value, Value> {
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(json!({
            "ok": false,
            "code": "E1004",
            "message": format!("未允许的 IPC method：{method}")
        }));
    }
    let payload = payload.unwrap_or_else(|| json!({}));
    let timeout = timeout_for(&payload);
    call(backend.inner_clone(), method, payload, timeout)
        .await
        .map_err(error_value)
}

#[tauri::command]
pub fn ling_restart_backend(app: AppHandle, backend: State<'_, Backend>) -> Value {
    // 主动重启期间抑制托盘/退出逻辑
    if let Some(rt) = app.try_state::<crate::Runtime>() {
        if rt.quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return json!({ "ok": false, "message": "应用正在退出" });
        }
    }
    backend.restart();
    json!({ "ok": true, "message": "已发出后端重启请求，正在等待就绪" })
}

/// 选文件：只返回本机路径，不读内容、不落盘。
/// 渲染进程没有文件系统权限，所以只能由原生对话框给出。
#[tauri::command]
pub async fn ling_pick_file(app: AppHandle, opts: Option<Value>) -> Value {
    use tauri_plugin_dialog::DialogExt;

    let kind = opts
        .as_ref()
        .and_then(|o| o.get("kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("file")
        .to_string();

    let mut builder = app.dialog().file();
    builder = match kind.as_str() {
        "image" => builder.add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "bmp"]),
        "video" => builder.add_filter("视频", &["mp4", "mov", "mkv", "avi", "webm"]),
        "record" => builder.add_filter("语音", &["mp3", "wav", "amr", "silk", "ogg", "m4a"]),
        _ => builder.add_filter("所有文件", &["*"]),
    };

    match builder.blocking_pick_file() {
        Some(path) => {
            let text = path.to_string();
            json!({ "ok": true, "path": text })
        }
        None => json!({ "ok": false, "canceled": true }),
    }
}

#[tauri::command]
pub fn ling_meta() -> Value {
    json!({
        "shell": "Tauri",
        "platform": std::env::consts::OS,
        "versions": {
            "tauri": tauri::VERSION,
            "node": node_version(),
        }
    })
}

fn node_version() -> String {
    let mut cmd = std::process::Command::new(
        std::env::var("LING_NODE").unwrap_or_else(|_| "node".to_string()),
    );
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "?".into())
}
/// 启动 QQ。
///
/// 与 SnowLuma 同理，只接受"可执行文件路径"，但校验更严：
/// 文件名必须是 QQ.exe，且文件真实存在。否则这个接口就成了
/// "启动任意程序"的通用入口。
///
/// 用 detached 方式启动：QQ 是用户自己的程序，不该跟着 Ling-bot 一起退出。
///
/// 注意：`spawn()` 成功只代表进程被创建，**不代表它留下来了**。
/// QQ 可能因为已经在运行、缺少运行库、被安全软件拦下等原因
/// 起一下就退。所以这里启动后等一小会儿再确认一遍，
/// 并把"起来了但很快退出"当成失败报出来 —— 否则界面会说"已启动"，
/// 而用户看到的是没有任何反应。
#[tauri::command]
pub async fn ling_spawn_qq(exe: String) -> Value {
    let p = std::path::PathBuf::from(&exe);
    let fname = p
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if fname != "qq.exe" || !p.is_file() {
        return json!({
            "ok": false,
            "code": "E1004",
            "message": format!("不是有效的 QQ 可执行文件：{exe}")
        });
    }

    /*
     * 启动 + 确认要等 3 秒，绝不能放在同步命令里：
     * Tauri 的同步命令在主线程跑，睡 3 秒会把整个界面冻住。
     * 放到 blocking 线程池里做，命令本身保持 async。
     */
    let res = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&p);
        // 工作目录设成它自己的目录：QQ 会按相对路径找同级的资源文件
        if let Some(parent) = p.parent() {
            cmd.current_dir(parent);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW | DETACHED_PROCESS：不弹控制台，也不随父进程退出
            cmd.creation_flags(0x0800_0000 | 0x0000_0008);
        }
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return json!({
                    "ok": false,
                    "code": "E1011",
                    "message": format!("启动 QQ 失败：{e}")
                })
            }
        };
        let pid = child.id();

        /*
         * 等 3 秒再确认进程还活着。
         *
         * 为什么必须等：`spawn()` 成功只代表进程被创建，**不代表它留下了**。
         * QQ 可能因为缺运行库、被安全软件拦下、安装损坏而起一下就退。
         * 只报"已启动"会让用户对着毫无反应的屏幕发愣。
         *
         * 另外 QQ 是单实例程序：已经在跑时，新进程会把请求转交给
         * 已有实例然后自己退出。这种情况用户要的效果已经达成，
         * 所以只要"有 QQ 在跑"就算成功。
         */
        std::thread::sleep(std::time::Duration::from_millis(3000));
        let alive = qq_process_count();

        if alive > 0 {
            json!({
                "ok": true,
                "pid": pid,
                "running": alive,
                "message": format!("QQ 已启动（{alive} 个进程）")
            })
        } else {
            json!({
                "ok": false,
                "code": "E1012",
                "message": "QQ 启动了但立刻退出。常见原因：缺少运行库、被安全软件拦下，或安装损坏。"
            })
        }
    })
    .await;

    match res {
        Ok(v) => v,
        Err(e) => json!({
            "ok": false,
            "code": "E1013",
            "message": format!("启动 QQ 时内部出错：{e}")
        }),
    }
}

/// 当前有几个 QQ.exe 在跑。
///
/// 用 PowerShell 的 CIM 查询而不是解析 tasklist 的文本：
/// 后者在不同语言版本下输出不同，还会把提示语里的 "QQ.exe" 算成命中。
#[cfg(windows)]
fn qq_process_count() -> usize {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "@(Get-CimInstance Win32_Process -Filter \"Name='QQ.exe'\" -ErrorAction SilentlyContinue).Count",
        ])
        .creation_flags(0x0800_0000)
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse::<usize>()
            .unwrap_or(0),
        Err(_) => 0,
    }
}

#[cfg(not(windows))]
fn qq_process_count() -> usize {
    0
}

#[cfg(test)]
mod tests {
    use super::url_allowed;

    /*
     * 这个白名单是"能不能打开任意网址"的唯一闸门，值得逐条钉住。
     * 尤其是 file:// 与用 user@host 伪装的地址 —— 它们是这类接口最常见
     * 的两种绕过方式。
     */
    #[test]
    fn allows_local_console_and_known_hosts() {
        assert!(url_allowed("http://127.0.0.1:5099/"));
        assert!(url_allowed("http://localhost:5099/"));
        assert!(url_allowed("https://nodejs.org/dist/latest-v24.x/win-x64/"));
        assert!(url_allowed("https://github.com/SnowLuma/SnowLuma/releases/latest"));
        assert!(url_allowed("https://objects.githubusercontent.com/a/b.zip"));
    }

    #[test]
    fn rejects_everything_else() {
        assert!(!url_allowed("file:///C:/Windows/System32/calc.exe"));
        assert!(!url_allowed("javascript:alert(1)"));
        assert!(!url_allowed(""));
        assert!(!url_allowed("http://evil.example/"));
        assert!(!url_allowed("https://evil.example/"));
        // 白名单主机不允许降级成明文 http
        assert!(!url_allowed("http://nodejs.org/"));
        // user@host 伪装：真正的 host 是 evil.example
        assert!(!url_allowed("https://nodejs.org@evil.example/"));
        // 后缀相近但不同域
        assert!(!url_allowed("https://evilnodejs.org/"));
    }

    #[test]
    fn qq_spawn_rejects_non_qq_executable() {
        // 这个接口的闸门：文件名不是 QQ.exe 一律拒绝，
        // 否则它就成了"启动任意程序"的通用入口。
        let tmp = std::env::temp_dir().join("not-a-qq.exe");
        std::fs::write(&tmp, b"x").unwrap();
        let out = tauri::async_runtime::block_on(super::ling_spawn_qq(
            tmp.to_string_lossy().to_string(),
        ));
        std::fs::remove_file(&tmp).ok();
        assert_eq!(out["ok"], serde_json::json!(false));
        assert_eq!(out["code"], serde_json::json!("E1004"));
    }

    #[test]
    fn qq_spawn_rejects_missing_file() {
        let out = tauri::async_runtime::block_on(super::ling_spawn_qq(
            r"C:\definitely\not\here\QQ.exe".to_string(),
        ));
        assert_eq!(out["ok"], serde_json::json!(false));
        assert_eq!(out["code"], serde_json::json!("E1004"));
    }
}

