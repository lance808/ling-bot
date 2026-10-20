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

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::backend::{Backend, RpcError};

const ALLOWED_METHODS: [&str; 3] = ["snapshot", "action", "setting"];

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
