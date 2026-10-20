//! Node 后端守护
//!
//! 与旧版 Electron supervisor 保持同一套语义：
//!   · 以子进程方式运行 `src/index.mjs`，stdio 上跑 JSON-RPC 行协议
//!   · 崩溃退避重启 1s→2s→4s→8s→30s，连续 5 次失败后放弃并通知界面
//!   · 「重启后端」是一等动作，不关窗口
//!
//! 为什么不把后端用 Rust 重写：后端的价值全在业务规则（准入、用量、思考、
//! 插件），重写等于把已测过的 452 个用例推倒重来。这里只换外壳。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use serde_json::{json, Value};

const BACKOFF_MS: [u64; 5] = [1_000, 2_000, 4_000, 8_000, 30_000];
const MAX_FAILURES: u32 = 5;

/// 去掉 Windows 的 `\\?\`（verbatim）前缀。
///
/// 这类路径在 Rust 侧合法，但传给 node 会被当成 UNC 主机名，
/// 结果就是进程起不来、界面永远停在“正在启动”。
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    if let Some(rest) = s.strip_prefix(r"\\.\") {
        return PathBuf::from(rest);
    }
    p
}

pub struct RpcError {
    pub code: Option<String>,
    pub message: String,
}

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, RpcError>>>>>;

struct Inner {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Pending,
    seq: AtomicU64,
    failures: AtomicU32,
    stopping: AtomicBool,
    stderr_tail: Mutex<Vec<String>>,
}

#[derive(Clone)]
pub struct Backend {
    app: AppHandle,
    data_dir: PathBuf,
    inner: Arc<Inner>,
}

impl Backend {
    pub fn new(app: AppHandle, data_dir: PathBuf) -> Self {
        Self {
            app,
            data_dir,
            inner: Arc::new(Inner {
                child: Mutex::new(None),
                stdin: Mutex::new(None),
                pending: Arc::new(Mutex::new(HashMap::new())),
                seq: AtomicU64::new(0),
                failures: AtomicU32::new(0),
                stopping: AtomicBool::new(false),
                stderr_tail: Mutex::new(Vec::new()),
            }),
        }
    }

    /// 后端脚本位置：打包后用资源目录，开发期用仓库里的 src。
    fn backend_path(&self) -> Result<PathBuf, String> {
        // 打包：资源目录里的 backend/index.mjs
        if let Ok(resource_dir) = self.app.path().resource_dir() {
            let bundled = resource_dir.join("backend").join("index.mjs");
            if bundled.is_file() {
                return Ok(strip_verbatim(bundled));
            }
        }
        /*
         * 开发：exe 在 desktop/target/<profile>/ 下，往上找带 src/index.mjs 的目录。
         *
         * Windows 上 current_exe / canonicalize 都可能返回带 `\\?\` 前缀的
         * “verbatim” 路径。node 收到这种路径会按 UNC 解析并在启动时失败，
         * 表现就是界面一直停在“正在启动”。所以统一剥掉前缀。
         */
        if let Ok(exe) = std::env::current_exe() {
            let normalized = strip_verbatim(exe);
            let mut dir = normalized.parent().map(|p| p.to_path_buf());
            while let Some(d) = dir {
                let candidate = d.join("src").join("index.mjs");
                if candidate.is_file() {
                    return Ok(strip_verbatim(candidate));
                }
                dir = d.parent().map(|p| p.to_path_buf());
            }
        }
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|root| root.join("src").join("index.mjs"))
            .ok_or("无法定位后端入口")?;
        if dev.is_file() {
            return Ok(strip_verbatim(dev));
        }
        Err(format!("找不到后端入口：{}", dev.display()))
    }

    /// Node 可执行文件：打包后随包带，开发期用 PATH 上的 node。
    fn node_path(&self) -> String {
        if let Ok(resource_dir) = self.app.path().resource_dir() {
            let bundled = resource_dir.join("runtime").join("node.exe");
            if bundled.is_file() {
                return bundled.to_string_lossy().into_owned();
            }
        }
        if let Ok(explicit) = std::env::var("LING_NODE") {
            if !explicit.is_empty() {
                return explicit;
            }
        }
        "node".to_string()
    }

    pub fn start(&self) {
        if self.inner.child.lock().map(|c| c.is_some()).unwrap_or(false) {
            return;
        }
        self.inner.stopping.store(false, Ordering::SeqCst);

        let backend_path = match self.backend_path() {
            Ok(p) => p,
            Err(message) => {
                self.emit_lifecycle("backend-gave-up", json!({ "message": message }));
                return;
            }
        };
        // 后端用相对路径找 plugins/ 与 assets/，cwd 必须是仓库根（开发）
        // 或资源根（打包）。两者都是 index.mjs 的上两级。
        let cwd = backend_path
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| self.data_dir.clone());

        let mut cmd = Command::new(self.node_path());
        cmd.arg(&backend_path)
            .current_dir(cwd)
            .env("LING_USER_DATA", &self.data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // 不弹黑框
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.handle_spawn_error(&e.to_string());
                return;
            }
        };

        if let Some(stdin) = child.stdin.take() {
            if let Ok(mut slot) = self.inner.stdin.lock() {
                *slot = Some(stdin);
            }
        }

        if let Some(stdout) = child.stdout.take() {
            let inner = self.inner.clone();
            let app = self.app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    dispatch_line(&inner, &app, &line);
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let inner = self.inner.clone();
            let app = self.app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    if let Ok(mut tail) = inner.stderr_tail.lock() {
                        tail.push(line.clone());
                        if tail.len() > 100 {
                            tail.remove(0);
                        }
                    }
                    emit(&app, "backend-stderr", json!({ "line": line }));
                }
            });
        }

        let pid = child.id();
        if let Ok(mut slot) = self.inner.child.lock() {
            *slot = Some(child);
        }
        let _ = pid;

        // 等待进程退出，然后决定是否重启
        let this = self.clone();
        std::thread::spawn(move || this.wait_exit());
    }

    fn wait_exit(self) {
        let status = {
            let mut guard = match self.inner.child.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match guard.as_mut() {
                Some(child) => child.wait().ok(),
                None => return,
            }
        };
        if let Ok(mut guard) = self.inner.child.lock() {
            *guard = None;
        }
        if let Ok(mut stdin) = self.inner.stdin.lock() {
            *stdin = None;
        }

        // 失败所有在途请求
        if let Ok(mut pending) = self.inner.pending.lock() {
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err(RpcError {
                    code: Some("E1001".into()),
                    message: "后端已退出".into(),
                }));
            }
        }

        if self.inner.stopping.load(Ordering::SeqCst) {
            return;
        }

        let failures = self.inner.failures.fetch_add(1, Ordering::SeqCst) + 1;
        let (code, signal) = status
            .map(|s| (s.code(), None::<i32>))
            .unwrap_or((None, None));
        let tail = self
            .inner
            .stderr_tail
            .lock()
            .map(|t| t.clone())
            .unwrap_or_default();
        self.emit_lifecycle(
            "backend-crashed",
            json!({ "code": code, "signal": signal, "failures": failures, "stderrTail": tail }),
        );

        if failures >= MAX_FAILURES {
            self.emit_lifecycle(
                "backend-gave-up",
                json!({
                    "failures": failures,
                    "stderrTail": tail,
                    "message": "后端连续多次启动失败，已停止自动重启，需要人工介入"
                }),
            );
            return;
        }

        let delay = BACKOFF_MS[((failures - 1) as usize).min(BACKOFF_MS.len() - 1)];
        self.emit_lifecycle(
            "backend-restarting",
            json!({ "delayMs": delay, "attempt": failures }),
        );
        let this = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay));
            if !this.inner.stopping.load(Ordering::SeqCst) {
                this.start();
            }
        });
    }

    fn handle_spawn_error(&self, message: &str) {
        self.emit_lifecycle(
            "backend-gave-up",
            json!({ "message": format!("无法启动后端：{message}") }),
        );
    }

    /// 同步请求，带超时。外层（rpc 模块）负责丢到阻塞线程。
    pub fn request_blocking(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> Result<Value, RpcError> {
        let id = self.inner.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx): (Sender<Result<Value, RpcError>>, Receiver<Result<Value, RpcError>>) =
            mpsc::channel();
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.insert(id, tx);
        }

        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let write_result = {
            let mut guard = match self.inner.stdin.lock() {
                Ok(g) => g,
                Err(_) => {
                    return Err(RpcError {
                        code: Some("E1002".into()),
                        message: "后端管道不可用".into(),
                    })
                }
            };
            match guard.as_mut() {
                Some(stdin) => stdin
                    .write_all(format!("{line}\n").as_bytes())
                    .and_then(|_| stdin.flush()),
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "后端未运行",
                )),
            }
        };
        if let Err(e) = write_result {
            if let Ok(mut pending) = self.inner.pending.lock() {
                pending.remove(&id);
            }
            return Err(RpcError {
                code: Some("E1003".into()),
                message: format!("后端未运行：{e}"),
            });
        }

        match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(res) => res,
            Err(_) => {
                if let Ok(mut pending) = self.inner.pending.lock() {
                    pending.remove(&id);
                }
                Err(RpcError {
                    code: Some("E1030".into()),
                    message: format!("后端未在 {timeout_ms}ms 内响应 {method}"),
                })
            }
        }
    }

    pub fn restart(&self) {
        self.inner.failures.store(0, Ordering::SeqCst);
        self.inner.stopping.store(false, Ordering::SeqCst);
        let mut guard = match self.inner.child.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
        drop(guard);
        // 退出回调里会因 stopping=false 触发退避重启；这里主动拉起来更快
        let this = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            this.start();
        });
        self.emit_lifecycle("backend-restarting", json!({ "delayMs": 200, "attempt": 0 }));
    }

    /// 复制一个句柄给阻塞线程使用（State 借用不能跨 await）。
    pub fn inner_clone(&self) -> Self {
        self.clone()
    }

    pub fn stop(&self) {
        self.inner.stopping.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.inner.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
        }
    }

    fn emit_lifecycle(&self, event: &str, payload: Value) {
        emit(&self.app, event, payload);
    }
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("ling:event", json!({ "event": event, "payload": payload }));
    }
}

fn dispatch_line(inner: &Arc<Inner>, app: &AppHandle, line: &str) {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
        let tx = inner.pending.lock().ok().and_then(|mut p| p.remove(&id));
        if let Some(tx) = tx {
            if let Some(err) = msg.get("error") {
                let _ = tx.send(Err(RpcError {
                    code: err
                        .get("code")
                        .and_then(|c| c.as_str())
                        .map(|s| s.to_string()),
                    message: err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("后端返回错误")
                        .to_string(),
                }));
            } else {
                let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
            }
        }
        return;
    }

    if msg.get("method").and_then(|m| m.as_str()) == Some("event") {
        if let Some(params) = msg.get("params") {
            if params.get("event").and_then(|e| e.as_str()) == Some("ready") {
                inner.failures.store(0, Ordering::SeqCst);
            }
            emit(app, "backend-event", params.clone());
        }
    }
}
