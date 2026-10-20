// 让 Windows 上的桌面程序使用 GUI 子系统：双击启动不弹控制台黑窗。
//
// 不加这一行时，cargo 产出的 exe 带 console 子系统，双击就会先出现一个
// 黑窗口，关掉它程序也会退出 —— 这是桌面应用最显眼的“不专业”细节。
//
// 用 crate 级属性而不是写 manifest：Windows 上 .crate root 加
// `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
// 是 Tauri 官方模板的做法，release 版生效、debug 版保留控制台便于看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ling_bot_desktop_lib::run()
}
