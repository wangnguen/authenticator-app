import { useEffect, useState } from "react";
import { Icon } from "@auth/ui";
import { api, type ExtensionInfo } from "../api";

interface Props {
  onClose: () => void;
}

/** Modal thông tin kết nối với extension Chrome/Edge (native messaging). */
export function ExtensionDialog({ onClose }: Props) {
  const [info, setInfo] = useState<ExtensionInfo | null>(null);

  useEffect(() => {
    void api.extensionInfo().then(setInfo);
  }, []);

  // Esc để đóng.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
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

        <div className="dialog__actions">
          <button type="button" className="auth-btn auth-btn--primary" onClick={onClose} autoFocus>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
