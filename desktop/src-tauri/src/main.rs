// Ẩn cửa sổ console khi build release trên Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod commands;
mod error;
mod ipc;
mod native_host;
mod otpauth;
mod register;
mod totp;
mod vault;

fn main() {
    // Chrome/Edge chạy lại chính exe này làm native messaging host,
    // truyền origin "chrome-extension://<id>/" làm tham số.
    if native_host::is_native_host_launch() {
        native_host::run();
        return;
    }
    app::run();
}
