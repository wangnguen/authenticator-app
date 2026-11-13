import { useState } from "react";
import { type CodeEntry, describeImport, errorMessage, type ImportResult } from "@auth/core";
import { CodeList, Icon, SearchBox, useCodes } from "@auth/ui";
import { fillCode, scanQrOnPage } from "./page";

type Notice = { kind: "success" | "error"; text: string } | null;

interface Props {
  /** Phải là hàm cố định (không tạo mới mỗi lần render), vì `useCodes` gọi lại khi nó đổi. */
  list: () => Promise<CodeEntry[]>;
  /** Thêm tài khoản từ các link otpauth đọc được trên trang. */
  add: (uris: string) => Promise<ImportResult>;
  emptyText: string;
}

/** Danh sách mã: tìm kiếm, điền mã vào trang, quét QR trên trang để thêm tài khoản. */
export function Codes({ list, add, emptyText }: Props) {
  const { entries, error, loading, now, refresh } = useCodes(list);
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
      const result = await add(uris.join("\n"));
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
            emptyText={emptyText}
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
