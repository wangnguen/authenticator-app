import { useCallback, useEffect, useState } from "react";
import { describeImport, errorMessage, type VaultStatus } from "@auth/core";
import { CodeList, Icon, SearchBox, useCodes } from "@auth/ui";
import { native } from "./native";
import { fillCode, scanQrOnPage } from "./page";

type Notice = { kind: "success" | "error"; text: string } | null;

const listCodes = () => native.request({ type: "list_codes" });

export function Popup() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    setConnectError(null);
    try {
      setStatus(await native.request({ type: "status" }));
    } catch (e) {
      setStatus(null);
      setConnectError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  let body;
  if (connectError) {
    body = <Message text={connectError} onRetry={checkStatus} />;
  } else if (!status) {
    body = <p className="auth-empty">Đang kết nối app desktop...</p>;
  } else if (!status.exists) {
    body = <Message text="Chưa tạo vault. Hãy mở app desktop để thiết lập." onRetry={checkStatus} />;
  } else if (!status.unlocked) {
    body = <Message text="Vault đang khoá. Hãy mở khoá trong app desktop." onRetry={checkStatus} />;
  } else {
    body = <Codes />;
  }

  return (
    <main className="popup">
      <header className="popup__header">
        <h1>
          <Icon name="shield-lock" size={20} /> Authenticator
        </h1>
      </header>
      {body}
    </main>
  );
}

function Message({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="popup__message">
      <p className="auth-muted">{text}</p>
      <button className="auth-btn" onClick={onRetry}>
        Thử lại
      </button>
    </div>
  );
}

function Codes() {
  const { entries, error, loading, now, refresh } = useCodes(listCodes);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [scanning, setScanning] = useState(false);

  const fill = async (code: string) => {
    try {
      if (await fillCode(code)) window.close();
      else setNotice({ kind: "error", text: "Không tìm thấy ô nhập mã trên trang." });
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e) });
    }
  };

  const scan = async () => {
    setScanning(true);
    setNotice(null);
    try {
      const uris = await scanQrOnPage();
      if (uris.length === 0) {
        setNotice({ kind: "error", text: "Không thấy QR code 2FA trên trang." });
        return;
      }
      const result = await native.request({ type: "add_uri", uri: uris.join("\n") });
      setNotice({ kind: "success", text: describeImport(result) });
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e) });
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      <div className="popup__toolbar">
        <SearchBox value={query} onChange={setQuery} />
        <button className="auth-btn" onClick={scan} disabled={scanning} title="Quét QR trên trang">
          {scanning ? (
            "..."
          ) : (
            <>
              <Icon name="camera" /> QR
            </>
          )}
        </button>
      </div>
      {notice && (
        <p className={notice.kind === "success" ? "auth-success" : "auth-error"}>{notice.text}</p>
      )}
      {error && <p className="auth-error">{error}</p>}
      {!loading && (
        <div className="popup__list">
          <CodeList
            entries={entries}
            now={now}
            query={query}
            emptyText="Chưa có tài khoản. Thêm trong app desktop hoặc quét QR."
            renderActions={(entry) => (
              <button
                className="auth-btn auth-btn--small"
                onClick={() => fill(entry.code)}
                title="Điền mã vào trang"
              >
                Điền
              </button>
            )}
          />
        </div>
      )}
    </>
  );
}
