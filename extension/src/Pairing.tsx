import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@auth/core";
import { native, saveToken } from "./native";

interface Props {
  /** Có token cũ nhưng app không nhận (đã bị thu hồi). */
  revoked: boolean;
  onPaired: () => void;
}

/**
 * Yêu cầu đang chờ. Popup đóng ngay khi app desktop bật lên, nên `requestId` được tạo và lưu
 * TRƯỚC khi gửi; mở lại popup là hỏi tiếp kết quả.
 */
const PENDING_KEY = "pairPending";
const POLL_MS = 1000;
/** Lỗi khi hỏi kết quả (app vừa khởi động lại, timeout...): thử lại sau khoảng này. */
const RETRY_MS = 3000;

type State =
  | { step: "idle"; message: string | null }
  | { step: "waiting"; requestId: string; code: string | null };

function browserName(): string {
  return navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome";
}

function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Màn hình ghép đôi extension với app desktop (lần đầu, hoặc sau khi bị thu hồi). */
export function Pairing({ revoked, onPaired }: Props) {
  const [state, setState] = useState<State>({ step: "idle", message: null });
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const stop = useCallback(async (message: string | null) => {
    clearTimeout(timer.current);
    await chrome.storage.session.remove(PENDING_KEY);
    setState({ step: "idle", message });
  }, []);

  const poll = useCallback(
    async (requestId: string) => {
      try {
        const result = await native.request({ type: "pair_status", requestId });
        setError(null);
        switch (result.status) {
          case "pending":
            setState({ step: "waiting", requestId, code: result.code });
            timer.current = setTimeout(() => void poll(requestId), POLL_MS);
            return;
          case "approved":
            await saveToken(result.token);
            await stop(null);
            onPaired();
            return;
          case "denied":
            await stop("App desktop đã từ chối kết nối.");
            return;
          case "expired":
            await stop("Yêu cầu kết nối đã hết hạn. Hãy thử lại.");
        }
      } catch (e) {
        setError(`${errorMessage(e)} Đang thử lại…`);
        timer.current = setTimeout(() => void poll(requestId), RETRY_MS);
      }
    },
    [stop, onPaired],
  );

  // Mở lại popup sau khi bấm Cho phép trong app: tiếp tục yêu cầu đang chờ.
  useEffect(() => {
    void chrome.storage.session.get(PENDING_KEY).then((stored) => {
      const requestId = stored[PENDING_KEY] as string | undefined;
      if (!requestId) return;
      setState({ step: "waiting", requestId, code: null });
      void poll(requestId);
    });
    return () => clearTimeout(timer.current);
  }, [poll]);

  const start = async () => {
    setError(null);
    clearTimeout(timer.current);
    const requestId = newRequestId();
    await chrome.storage.session.set({ [PENDING_KEY]: requestId });
    setState({ step: "waiting", requestId, code: null });
    try {
      const request = await native.request({ type: "pair_request", requestId, name: browserName() });
      setState({ step: "waiting", requestId, code: request.code });
    } catch (e) {
      await stop(null);
      setError(errorMessage(e));
      return;
    }
    void poll(requestId);
  };

  return (
    <div className="popup__message">
      {state.step === "waiting" ? (
        <>
          <p>Mã xác nhận</p>
          <p className="pair-code">{state.code ?? "··· ···"}</p>
          <p className="auth-muted">
            App desktop đang hỏi có cho phép extension này không. Kiểm tra mã giống nhau rồi bấm{" "}
            <strong>Cho phép</strong>.
          </p>
          <p className="auth-muted hint">Đang chờ…</p>
          <button className="auth-btn" onClick={() => void stop(null)}>
            Huỷ
          </button>
        </>
      ) : (
        <>
          <p className="auth-muted">
            {revoked
              ? "Kết nối với app desktop đã bị thu hồi. Hãy kết nối lại."
              : "Extension cần được cho phép trong app desktop trước khi lấy mã."}
          </p>
          {state.message && <p className="auth-error">{state.message}</p>}
          <button className="auth-btn auth-btn--primary" onClick={() => void start()}>
            Kết nối với app
          </button>
        </>
      )}
      {error && <p className="auth-error">{error}</p>}
    </div>
  );
}
