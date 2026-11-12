import { useEffect, useState } from "react";
import { errorMessage } from "@auth/core";
import { Icon } from "@auth/ui";
import { api, type BrowserName, type ExtensionInfo, type ExtensionPackage } from "../api";

interface Props {
  onClose: () => void;
}

const BROWSERS: { id: BrowserName; name: string; page: string }[] = [
  { id: "chrome", name: "Chrome", page: "chrome://extensions" },
  { id: "edge", name: "Edge", page: "edge://extensions" },
];

/** Modal kết nối với extension Chrome/Edge: trạng thái native host và cài extension. */
export function ExtensionDialog({ onClose }: Props) {
  const [info, setInfo] = useState<ExtensionInfo | null>(null);
  const [pkg, setPkg] = useState<ExtensionPackage | null>(null);
  const [browser, setBrowser] = useState<(typeof BROWSERS)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.extensionInfo().then(setInfo);
    void api.extensionPackage().then(setPkg, (e) => setError(errorMessage(e)));
  }, []);

  // Esc để đóng.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Không copy được thì người dùng vẫn chọn tay theo đường dẫn hiển thị.
    }
  };

  const install = async (target: (typeof BROWSERS)[number]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.installExtension(target.id);
      setPkg(result.package);
      setBrowser(target);
      if (result.package.path) await copyPath(result.package.path);
      if (result.browserError) {
        setError(`${result.browserError} Hãy tự mở ${target.page} trong trình duyệt.`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog dialog--wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Kết nối extension</h2>

        {!info ? (
          <p className="auth-muted">Đang tải…</p>
        ) : (
          <>
            {info.error ? (
              <p className="auth-error">Chưa đăng ký được native host: {info.error}</p>
            ) : (
              <p className="auth-success">
                <Icon name="check" /> Đã đăng ký native host cho Chrome và Edge
              </p>
            )}
            <dl className="info-list">
              <dt>Extension ID</dt>
              <dd className="mono">{info.extensionId}</dd>
              <dt>Host</dt>
              <dd className="mono">{info.hostName}</dd>
            </dl>
            <p className="auth-muted hint">
              Giữ app này chạy để extension lấy được mã. Mã chỉ trả về khi vault đang mở khoá.
            </p>
          </>
        )}

        <h3>Cài extension vào trình duyệt</h3>
        {pkg && !pkg.bundled ? (
          <p className="auth-muted hint">
            Bản build này không kèm extension (cần chạy <code>pnpm build:extension</code> trước khi
            build app).
          </p>
        ) : (
          <>
            <div className="install-buttons">
              {BROWSERS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="auth-btn auth-btn--primary"
                  onClick={() => void install(b)}
                  disabled={busy || !pkg}
                >
                  <Icon name="puzzle" /> Cài vào {b.name}
                </button>
              ))}
            </div>

            {pkg?.path && (
              <>
                <ol className="install-steps">
                  <li>
                    Ở trang <span className="mono">{browser?.page ?? "chrome://extensions"}</span>
                    {browser ? " vừa mở" : ""}, bật <strong>Developer mode</strong> (Chế độ dành
                    cho nhà phát triển).
                  </li>
                  <li>
                    Bấm <strong>Load unpacked</strong> (Tải tiện ích đã giải nén).
                  </li>
                  <li>
                    Chọn thư mục dưới đây. Đường dẫn {copied ? "đã được copy" : "có thể copy"}, dán
                    vào ô địa chỉ của hộp thoại chọn thư mục rồi bấm <strong>Select Folder</strong>.
                  </li>
                  <li>Bấm biểu tượng 🧩 trên thanh công cụ để ghim Authenticator.</li>
                </ol>
                <div className="install-path">
                  <span className="mono">{pkg.path}</span>
                  <button
                    type="button"
                    className="auth-btn auth-btn--small"
                    onClick={() => void copyPath(pkg.path!)}
                  >
                    {copied ? "Đã copy" : "Copy"}
                  </button>
                  <button
                    type="button"
                    className="auth-btn auth-btn--small"
                    onClick={() =>
                      void api.openExtensionFolder().catch((e) => setError(errorMessage(e)))
                    }
                  >
                    <Icon name="folder-open" /> Mở
                  </button>
                </div>
                <p className="auth-muted hint">
                  Extension {pkg.version && `v${pkg.version} `}tự cập nhật theo app; sau khi cập
                  nhật app, bấm Reload ở trang extensions hoặc mở lại trình duyệt.
                </p>
              </>
            )}
          </>
        )}

        {error && <p className="auth-error">{error}</p>}

        <div className="dialog__actions">
          <button type="button" className="auth-btn" onClick={onClose} autoFocus>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
