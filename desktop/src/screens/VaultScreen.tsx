import { useEffect, useState } from "react";
import { errorMessage } from "@auth/core";
import { CodeList, SearchBox, useCodes } from "@auth/ui";
import { api } from "../api";
import { AddAccountDialog } from "./AddAccountDialog";
import { ExtensionPanel } from "./ExtensionPanel";
import { GoogleAccountMenu } from "./GoogleAccountMenu";
import { SecurityPanel } from "./SecurityPanel";

type Panel = "extension" | "security" | null;

interface Props {
  /** false: vault không mật khẩu, ẩn nút khoá vì mở lại không cần gì. */
  hasPassword: boolean;
  onLock: () => void;
  onSecurityChanged: () => void;
}

export function VaultScreen({ hasPassword, onLock, onSecurityChanged }: Props) {
  const { entries, error, loading, now, refresh } = useCodes(api.listCodes);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const togglePanel = (next: Panel) => setPanel((p) => (p === next ? null : next));
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const unlisten = api.onVaultChanged(() => void refresh());
    return () => void unlisten.then((fn) => fn());
  }, [refresh]);

  const remove = async (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    try {
      await api.deleteAccount(id);
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  return (
    <main className="page">
      <header className="toolbar">
        <h1>Authenticator</h1>
        <div className="toolbar__actions">
          <button className="auth-btn auth-btn--primary" onClick={() => setAdding(true)}>
            + Thêm
          </button>
          <button
            className="auth-btn"
            onClick={() => togglePanel("extension")}
            title="Kết nối extension"
          >
            🧩
          </button>
          <button
            className="auth-btn"
            onClick={() => togglePanel("security")}
            title="Bảo mật"
          >
            ⚙
          </button>
          {hasPassword && (
            <button className="auth-btn" onClick={onLock} title="Khoá vault">
              🔒
            </button>
          )}
          <GoogleAccountMenu
            hasPassword={hasPassword}
            onRestored={() => {
              // Bản JSON không mã hoá khôi phục xong vẫn mở sẵn, nên tải lại danh sách mã.
              onSecurityChanged();
              void refresh();
            }}
          />
        </div>
      </header>

      {panel === "extension" && <ExtensionPanel />}
      {panel === "security" && (
        <SecurityPanel hasPassword={hasPassword} onChanged={onSecurityChanged} />
      )}

      <SearchBox value={query} onChange={setQuery} />

      {notice && <p className="auth-success">{notice}</p>}
      {(error || actionError) && <p className="auth-error">{error ?? actionError}</p>}

      {!loading && (
        <CodeList
          entries={entries}
          now={now}
          query={query}
          emptyText='Chưa có tài khoản nào. Bấm "+ Thêm" để bắt đầu.'
          renderActions={(entry) => (
            <button
              className="auth-btn auth-btn--small auth-btn--danger"
              onClick={() => remove(entry.id)}
              onBlur={() => setConfirmDelete(null)}
            >
              {confirmDelete === entry.id ? "Xác nhận?" : "Xoá"}
            </button>
          )}
        />
      )}

      {adding && (
        <AddAccountDialog
          onClose={() => setAdding(false)}
          onAdded={(message) => {
            setAdding(false);
            setNotice(message);
            void refresh();
          }}
        />
      )}
    </main>
  );
}
