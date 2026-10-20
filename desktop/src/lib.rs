mod backend;
mod rpc;

use backend::Backend;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// 托盘/退出期间抑制自动重启
struct Runtime {
    quitting: AtomicBool,
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            rpc::ling_invoke,
            rpc::ling_restart_backend,
            rpc::ling_pick_file,
            rpc::ling_meta
        ])
        .manage(Runtime {
            quitting: AtomicBool::new(false),
        })
        .setup(|app| {
            let handle = app.handle().clone();

            /*
             * 主窗口在这里创建，而不是写在 tauri.conf.json 里。
             *
             * 唯一原因是 initialization_script：桥接脚本必须在页面任何
             * <script> 之前就位，否则 app.mjs 一开头读 window.ling 会是
             * undefined。这是窗口级参数，配置里的 windows[] 表达不了。
             */
            let bridge = include_str!("../bridge.js");
            let win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Ling-bot")
            .inner_size(1180.0, 780.0)
            .min_inner_size(940.0, 620.0)
            .center()
            .background_color(tauri::window::Color(15, 17, 21, 255))
            .initialization_script(bridge)
            .visible(false)
            .build()?;
            let _ = win;

            // 托盘：点击显示窗口，右键菜单提供救场动作
            let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let reconnect = MenuItem::with_id(app, "reconnect", "重连 QQ", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启后端", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &reconnect, &restart, &quit])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("缺少应用图标")?;

            TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("Ling-bot")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "reconnect" => {
                        if let Some(be) = app.try_state::<Backend>() {
                            let backend = be.inner_clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = tauri::async_runtime::spawn_blocking(move || {
                                    backend.request_blocking(
                                        "action",
                                        serde_json::json!({ "name": "reconnect", "params": {} }),
                                        15_000,
                                    )
                                })
                                .await;
                            });
                        }
                    }
                    "restart" => {
                        if let Some(be) = app.try_state::<Backend>() {
                            be.restart();
                        }
                    }
                    "quit" => {
                        app.state::<Runtime>().quitting.store(true, Ordering::SeqCst);
                        if let Some(be) = app.try_state::<Backend>() {
                            be.stop();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                show_window(app);
                            }
                        }
                    }
                })
                .build(app)?;

            // 数据目录必须与旧版 Electron 完全一致，否则用户配置/凭据会“消失”。
            // Tauri 的 app_data_dir 会带上 identifier（com.ling-bot.desktop），
            // 而旧版一直用 %APPDATA%\ling-bot —— 这里显式取父目录下的 ling-bot。
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|_| "无法定位应用数据目录")?
                .parent()
                .map(|p| p.join("ling-bot"))
                .ok_or("无法定位应用数据目录")?;
            std::fs::create_dir_all(&data_dir).ok();

            let backend = Backend::new(handle.clone(), data_dir);
            app.manage(backend.clone());
            backend.start();

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 机器人要常驻：关窗只隐藏，真正退出走托盘
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("无法启动 Ling-bot 桌面端");
}
