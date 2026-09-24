import { decodeQrCodesFromImage, isOtpUri } from "@auth/ui";

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("Không tìm thấy tab đang mở.");
  return tab.id;
}

/** Điền mã vào ô input đang focus (hoặc ô OTP đoán được) trên trang hiện tại. */
export async function fillCode(code: string): Promise<boolean> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: await activeTabId() },
    func: injectCode,
    args: [code],
  });
  return Boolean(result?.result);
}

/** Chụp tab hiện tại và đọc mọi QR code 2FA (otpauth://, otpauth-migration://) trên trang. */
export async function scanQrOnPage(): Promise<string[]> {
  const screenshot = await chrome.tabs.captureVisibleTab({ format: "png" });
  return (await decodeQrCodesFromImage(screenshot)).filter(isOtpUri);
}

// Hàm này được serialize và chạy trong trang web, nên phải tự chứa mọi thứ nó cần.
function injectCode(code: string): boolean {
  const fillable = (el: Element | null): el is HTMLInputElement =>
    el instanceof HTMLInputElement &&
    !el.disabled &&
    !el.readOnly &&
    ["text", "tel", "number", "password", "search", ""].includes(el.type);

  const active = document.activeElement;
  let target: HTMLInputElement | null = fillable(active) ? active : null;

  if (!target) {
    const inputs = Array.from(document.querySelectorAll("input")).filter(
      (el) => fillable(el) && el.offsetParent !== null,
    );
    target =
      inputs.find((el) => el.autocomplete === "one-time-code") ??
      inputs.find((el) =>
        /otp|code|token|2fa|totp|mfa|verif/i.test(
          `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") ?? ""}`,
        ),
      ) ??
      null;
  }
  if (!target) return false;

  // Dùng setter gốc để framework (React, Vue...) nhận được thay đổi.
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  target.focus();
  if (setValue) setValue.call(target, code);
  else target.value = code;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
