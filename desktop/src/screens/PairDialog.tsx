import { useEffect, useState } from "react";
import { errorMessage, type PairRequestResult } from "@auth/core";
import { api } from "../api";

/** Sự kiện DOM phát ra sau khi cho phép một extension (để danh sách đã kết nối tải lại). */
export const PAIRED_EVENT = "auth:paired";

/**
 * Hỏi người dùng khi một extension xin kết nối với app. Extension hiện cùng mã xác nhận, nên người
 * dùng chỉ cho phép khi mã giống nhau (chống extension/tiến trình lạ giả danh).
 */
export function PairDialog() {
  const [request, setRequest] = useState<PairRequestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Yêu cầu gửi tới trước khi giao diện kịp lắng nghe (app vừa mở từ tray).
    void api.pairingPending().then((pending) => pending && setRequest(pending));
    const unlisten = api.onPairRequest((next) => {
      setError(null);
      setRequest(next);
    });
    return () => void unlisten.then((fn) => fn());
  }, []);

  if (!request) return null;

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.pairingDecide(request.requestId, approve);
      setRequest(null);
      if (approve) window.dispatchEvent(new Event(PAIRED_EVENT));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop dialog-backdrop--pair">
      <div className="dialog">
        <h2>Extension xin kết nối</h2>
        <p>
          Extension <strong>{request.name}</strong> muốn lấy mã 2FA từ app này.
        </p>
        <p className="auth-muted hint">Chỉ cho phép nếu mã dưới đây giống mã trong popup extension:</p>
        <p className="pair-code">{request.code}</p>
        <p className="auth-muted hint">
          Không phải bạn vừa bấm "Kết nối với app" trong extension? Hãy bấm Từ chối.
        </p>
        {error && <p className="auth-error">{error}</p>}
        <div className="dialog__actions">
          <button
            type="button"
            className="auth-btn auth-btn--danger"
            onClick={() => void decide(false)}
            disabled={busy}
          >
            Từ chối
          </button>
          <button
            type="button"
            className="auth-btn auth-btn--primary"
            onClick={() => void decide(true)}
            disabled={busy}
          >
            Cho phép
          </button>
        </div>
      </div>
    </div>
  );
}
