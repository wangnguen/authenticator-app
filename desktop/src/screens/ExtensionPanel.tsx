import { useEffect, useState } from "react";
import { api, type ExtensionInfo } from "../api";

export function ExtensionPanel() {
  const [info, setInfo] = useState<ExtensionInfo | null>(null);

  useEffect(() => {
    void api.extensionInfo().then(setInfo);
  }, []);

  if (!info) return null;

  return (
    <section className="panel">
      <h3>Kết nối extension</h3>
      {info.error ? (
        <p className="auth-error">Chưa đăng ký được native host: {info.error}</p>
      ) : (
        <p className="auth-success">✓ Đã đăng ký native host cho Chrome và Edge</p>
      )}
      <dl>
        <dt>Extension ID</dt>
        <dd className="mono">{info.extensionId}</dd>
        <dt>Host</dt>
        <dd className="mono">{info.hostName}</dd>
      </dl>
      <p className="auth-muted">
        Giữ app này chạy để extension lấy được mã. Mã chỉ trả về khi vault đang mở khoá.
      </p>
    </section>
  );
}
