import { useEffect, useState } from "react";
import { api, type UpdateStatus } from "../api";

/**
 * Báo đang tự cập nhật lúc mở app (app sẽ tự khởi động lại), hoặc cập nhật lỗi. Cập nhật ở nền
 * khi cửa sổ đang ẩn thì không cần báo.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    // Sự kiện có thể đã phát trước khi giao diện kịp lắng nghe: hỏi lại trạng thái hiện tại.
    void api.updateStatus().then((current) => current && setStatus(current), () => undefined);
    const unlisten = api.onUpdateStatus(setStatus);
    return () => void unlisten.then((fn) => fn());
  }, []);

  if (!status) return null;
  if (status.status === "installing") {
    return (
      <div className="update-banner">
        <span className="spinner" /> Đang cập nhật lên bản {status.version}, app sẽ tự khởi động lại…
      </div>
    );
  }
  return (
    <div className="update-banner update-banner--error" title={status.message}>
      Chưa cập nhật được lên bản {status.version}, sẽ thử lại sau.
      <button className="auth-btn auth-btn--small" onClick={() => setStatus(null)}>
        Đóng
      </button>
    </div>
  );
}
