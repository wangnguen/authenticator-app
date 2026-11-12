import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@auth/core";
import { CodeList, Icon, SearchBox, useCodes } from "@auth/ui";
import { api } from "../api";
import { AddAccountDialog } from "./AddAccountDialog";
import { ExtensionDialog } from "./ExtensionDialog";
import { GoogleAccountMenu } from "./GoogleAccountMenu";
import { SecurityDialog } from "./SecurityDialog";
import { TrashDialog } from "./TrashDialog";

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
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashCount, setTrashCount] = useState(0);
  /** Tăng khi vault trên máy đổi do người dùng hoặc extension: kích hoạt tự đồng bộ. */
  const [changeCount, setChangeCount] = useState(0);
  const [syncAttention, setSyncAttention] = useState<string | null>(null);
  const [attentionRequest, setAttentionRequest] = useState(0);
  const changed = useCallback(() => setChangeCount((n) => n + 1), []);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const refreshTrash = useCallback(
    () => api.listTrash().then((t) => setTrashCount(t.length), () => setTrashCount(0)),
    [],
  );

  /** Tải lại danh sách mã và số tài khoản trong Thùng rác. */
  const reload = useCallback(async () => {
    await Promise.all([refresh(), refreshTrash()]);
  }, [refresh, refreshTrash]);

  useEffect(() => {
    void refreshTrash();
  }, [refreshTrash]);

  useEffect(() => {
    const unlisten = api.onVaultChanged(() => {
      void reload();
      changed();
    });
    return () => void unlisten.then((fn) => fn());
  }, [reload, changed]);

  const remove = async (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    try {
      const entry = entries.find((e) => e.id === id);
      await api.deleteAccount(id);
      setConfirmDelete(null);
      setNotice(`Đã chuyển ${entry?.issuer || entry?.label || "tài khoản"} vào Thùng rác.`);
      changed();
      await reload();
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
            <Icon name="plus" /> Thêm
          </button>
          <button
            className="auth-btn auth-btn--icon"
            onClick={() => setExtensionOpen(true)}
            title="Kết nối extension"
          >
            <Icon name="puzzle" size={18} />
          </button>
          <button
            className="auth-btn auth-btn--icon"
            onClick={() => setSecurityOpen(true)}
            title="Bảo mật"
          >
            <Icon name="settings" size={18} />
          </button>
          {hasPassword && (
            <button className="auth-btn auth-btn--icon" onClick={onLock} title="Khoá vault">
              <Icon name="lock" size={18} />
            </button>
          )}
          <GoogleAccountMenu
            hasPassword={hasPassword}
            onRestored={() => {
              // Bản JSON không mã hoá khôi phục xong vẫn mở sẵn, nên tải lại danh sách mã.
              onSecurityChanged();
              void reload();
            }}
            onSynced={() => void reload()}
            changeCount={changeCount}
            attentionRequest={attentionRequest}
            onAttention={setSyncAttention}
          />
        </div>
      </header>

      {syncAttention && (
        <div className="sync-banner">
          <span>⚠ {syncAttention}</span>
          <button
            className="auth-btn auth-btn--small"
            onClick={() => setAttentionRequest((n) => n + 1)}
          >
            Xem
          </button>
        </div>
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

      {trashCount > 0 && (
        <button
          className="auth-btn auth-btn--small trash-link"
          onClick={() => setTrashOpen(true)}
          title="Tài khoản đã xoá, khôi phục được"
        >
          <Icon name="trash" /> Thùng rác ({trashCount})
        </button>
      )}

      {trashOpen && (
        <TrashDialog
          onClose={() => setTrashOpen(false)}
          onChanged={() => {
            changed();
            void reload();
          }}
        />
      )}

      {extensionOpen && <ExtensionDialog onClose={() => setExtensionOpen(false)} />}

      {securityOpen && (
        <SecurityDialog
          hasPassword={hasPassword}
          onChanged={onSecurityChanged}
          onClose={() => setSecurityOpen(false)}
        />
      )}

      {adding && (
        <AddAccountDialog
          onClose={() => setAdding(false)}
          onAdded={(message) => {
            setAdding(false);
            setNotice(message);
            changed();
            void refresh();
          }}
        />
      )}
    </main>
  );
}
