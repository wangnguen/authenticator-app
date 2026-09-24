import { useEffect, useState } from "react";
import { errorMessage } from "@auth/core";
import { CodeList, SearchBox, useCodes } from "@auth/ui";
import { api } from "../api";
import { AddAccountDialog } from "./AddAccountDialog";
import { ExtensionPanel } from "./ExtensionPanel";

interface Props {
  onLock: () => void;
}

export function VaultScreen({ onLock }: Props) {
  const { entries, error, loading, now, refresh } = useCodes(api.listCodes);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [showExtension, setShowExtension] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
            onClick={() => setShowExtension((v) => !v)}
            title="Kết nối extension"
          >
            🧩
          </button>
          <button className="auth-btn" onClick={onLock} title="Khoá vault">
            🔒
          </button>
        </div>
      </header>

      {showExtension && <ExtensionPanel />}

      <SearchBox value={query} onChange={setQuery} />

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
          onAdded={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}
    </main>
  );
}
