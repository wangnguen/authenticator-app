import { googleProfile, signIn } from "./standalone/google";
import { SIGN_IN_MESSAGE, type SignInResponse } from "./standalone/messages";
import { autoSync, forget } from "./standalone/vault";

/**
 * Service worker: tự đồng bộ vault của extension với Google Drive mỗi 15 phút (khi đã đăng nhập
 * Google trong extension và vault đang mở). Không bao giờ tự xoá tài khoản: cần xác nhận thì
 * hiện dấu "!" trên icon extension.
 */

const ALARM = "auto-sync";
const PERIOD_MINUTES = 15;

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 1 });
  }
}

async function run() {
  if (!(await googleProfile())) return;
  try {
    await autoSync();
  } catch (e) {
    console.warn("Tự đồng bộ lỗi:", e);
  }
}

chrome.runtime.onInstalled.addListener(() => void ensureAlarm());
chrome.runtime.onStartup.addListener(() => void ensureAlarm().then(run));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void run();
});

// Đăng nhập Google chạy ở đây chứ không ở popup: cửa sổ đăng nhập mở ra làm popup đóng (và dừng
// mọi code đang chờ trong popup), còn service worker thì vẫn chạy tiếp để lưu kết quả.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || (message as { type?: string })?.type !== SIGN_IN_MESSAGE) {
    return false;
  }
  googleProfile()
    .then(async (current) => {
      // Chưa đăng nhập mà còn vault (của tài khoản cũ) thì xoá trước khi nhận tài khoản mới.
      if (!current) await forget();
      return signIn(current?.email);
    })
    .then(async (profile) => {
      sendResponse({ ok: true, profile } satisfies SignInResponse);
      await run();
    })
    .catch((e: unknown) => {
      const error = e as { code?: string; message?: string };
      sendResponse({
        ok: false,
        error: { code: error.code ?? "GOOGLE_AUTH_FAILED", message: error.message ?? String(e) },
      } satisfies SignInResponse);
    });
  return true;
});
