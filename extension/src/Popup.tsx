import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, isAppError, type VaultStatus } from "@auth/core";
import { Icon } from "@auth/ui";
import { Codes } from "./Codes";
import { GoogleSource } from "./GoogleSource";
import { loadToken, native, NativeError, saveToken } from "./native";
import { Pairing } from "./Pairing";
import { googleProfile } from "./standalone/google";

/**
 * Hai nguồn mã:
 * - "app": hỏi app desktop qua native messaging (secret không bao giờ rời app).
 * - "google": vault riêng của extension, đồng bộ trực tiếp với Google Drive (không cần app).
 */
type Source = "app" | "google";

const SOURCE_KEY = "preferredSource";

const listAppCodes = () => native.request({ type: "list_codes" });
const addToApp = (uri: string) => native.request({ type: "add_uri", uri });

export function Popup() {
  const [source, setSource] = useState<Source | null>(null);
  /** App desktop không chạy nên tự chuyển sang Google Drive (không lưu lựa chọn). */
  const [fallback, setFallback] = useState(false);
  /** Chỉ tự chuyển nguồn lúc mở popup; người dùng đã tự chọn tab thì thôi. */
  const autoFallback = useRef(true);

  useEffect(() => {
    void chrome.storage.local.get(SOURCE_KEY).then((stored) => {
      setSource(stored[SOURCE_KEY] === "google" ? "google" : "app");
    });
  }, []);

  const choose = (next: Source) => {
    autoFallback.current = false;
    setFallback(false);
    setSource(next);
    void chrome.storage.local.set({ [SOURCE_KEY]: next });
  };

  const appUnavailable = useCallback(async () => {
    if (autoFallback.current && (await googleProfile())) {
      autoFallback.current = false;
      setFallback(true);
      setSource("google");
    }
  }, []);

  return (
    <main className="popup">
      <header className="popup__header">
        <h1>
          <Icon name="shield-lock" size={20} /> Authenticator
        </h1>
        {source && (
          <div className="source-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={source === "app"}
              className={source === "app" ? "source-tab source-tab--active" : "source-tab"}
              onClick={() => choose("app")}
              title="Lấy mã từ app desktop"
            >
              App
            </button>
            <button
              role="tab"
              aria-selected={source === "google"}
              className={source === "google" ? "source-tab source-tab--active" : "source-tab"}
              onClick={() => choose("google")}
              title="Đồng bộ trực tiếp với Google Drive, không cần app"
            >
              Google Drive
            </button>
          </div>
        )}
      </header>
      {fallback && (
        <p className="auth-muted hint">App desktop không chạy, đang dùng bản đồng bộ từ Google Drive.</p>
      )}
      {source === "app" && (
        <AppSource onUnavailable={appUnavailable} onUseGoogle={() => choose("google")} />
      )}
      {source === "google" && <GoogleSource />}
    </main>
  );
}

function AppSource({
  onUnavailable,
  onUseGoogle,
}: {
  onUnavailable: () => void;
  onUseGoogle: () => void;
}) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  /** null: đã ghép đôi; "new": chưa ghép đôi; "revoked": token cũ bị app thu hồi. */
  const [pairing, setPairing] = useState<"new" | "revoked" | null>(null);

  const checkStatus = useCallback(async () => {
    setConnectError(null);
    try {
      await loadToken();
      setStatus(await native.request({ type: "status" }));
      setPairing(null);
    } catch (e) {
      setStatus(null);
      const code = e instanceof NativeError ? e.code : isAppError(e) ? e.code : null;
      if (code === "NOT_PAIRED") {
        const hadToken = native.hasToken();
        await saveToken(null);
        setPairing(hadToken ? "revoked" : "new");
      } else {
        setConnectError(errorMessage(e));
        onUnavailable();
      }
    }
  }, [onUnavailable]);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const useGoogle = (
    <button className="auth-btn" onClick={onUseGoogle}>
      Dùng Google Drive (không cần app)
    </button>
  );

  if (pairing) {
    return (
      <>
        <Pairing revoked={pairing === "revoked"} onPaired={() => void checkStatus()} />
        <div className="popup__message">{useGoogle}</div>
      </>
    );
  }
  if (connectError) return <Message text={connectError} onRetry={checkStatus} extra={useGoogle} />;
  if (!status) return <p className="auth-empty">Đang kết nối app desktop...</p>;
  if (!status.exists) {
    return (
      <Message
        text="Chưa tạo vault. Hãy mở app desktop để thiết lập."
        onRetry={checkStatus}
        extra={useGoogle}
      />
    );
  }
  if (!status.unlocked) {
    return <Message text="Vault đang khoá. Hãy mở khoá trong app desktop." onRetry={checkStatus} />;
  }
  return (
    <Codes
      list={listAppCodes}
      add={addToApp}
      emptyText="Chưa có tài khoản. Thêm trong app desktop hoặc quét QR."
    />
  );
}

export function Message({
  text,
  onRetry,
  extra,
}: {
  text: string;
  onRetry: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="popup__message">
      <p className="auth-muted">{text}</p>
      <button className="auth-btn" onClick={onRetry}>
        Thử lại
      </button>
      {extra}
    </div>
  );
}
