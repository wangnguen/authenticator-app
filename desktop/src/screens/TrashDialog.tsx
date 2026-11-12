import { useCallback, useEffect, useState } from "react";
import { errorMessage, type TrashEntry } from "@auth/core";
import { api } from "../api";

interface Props {
  onClose: () => void;
  /** Gọi sau khi khôi phục / xoá vĩnh viễn để màn hình chính tải lại. */
  onChanged: () => void;
}

/** Tài khoản đã xoá: khôi phục lại hoặc xoá vĩnh viễn (bỏ hẳn secret). */
export function TrashDialog({ onClose, onChanged }: Props) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await api.listTrash());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (id: string, action: () => Promise<string>) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      setConfirmPurge(null);
      await load();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const restore = (entry: TrashEntry) =>
    run(entry.id, async () => {
      await api.restoreDeleted(entry.id);
      return `Đã khôi phục ${entry.issuer || entry.label}.`;
    });

  const purge = (entry: TrashEntry) => {
    if (confirmPurge !== entry.id) {
      setConfirmPurge(entry.id);
      return;
    }
    void run(entry.id, async () => {
      await api.purgeDeleted(entry.id);
      return `Đã xoá vĩnh viễn ${entry.issuer || entry.label}.`;
    });
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog dialog--wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Thùng rác</h2>

        {entries === null ? (
          <p className="auth-muted">Đang tải…</p>
        ) : entries.length === 0 ? (
          <p className="auth-muted">Thùng rác trống.</p>
        ) : (
          <ul className="preview-list">
            {entries.map((entry) => (
              <li key={entry.id} className="preview-item">
                <div className="preview-item__name">
                  <strong>{entry.issuer || entry.label}</strong>
                  <span className="auth-muted">
                    {entry.issuer && entry.label ? `${entry.label} · ` : ""}xoá lúc{" "}
                    {new Date(entry.deletedAt).toLocaleString("vi-VN")}
                  </span>
                </div>
                <div className="trash-actions">
                  <button
                    type="button"
                    className="auth-btn auth-btn--small"
                    onClick={() => void restore(entry)}
                    disabled={busy !== null}
                  >
                    Khôi phục
                  </button>
                  <button
                    type="button"
                    className="auth-btn auth-btn--small auth-btn--danger"
                    onClick={() => purge(entry)}
                    onBlur={() => setConfirmPurge(null)}
                    disabled={busy !== null}
                    title="Xoá khỏi Thùng rác, không khôi phục từ đây được nữa. Các máy khác và bản trên Drive bỏ tài khoản này ở lần đồng bộ sau; bản vault cũ trong thư mục history vẫn còn."
                  >
                    {confirmPurge === entry.id ? "Chắc chắn?" : "Xoá vĩnh viễn"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="auth-muted hint">
          Tài khoản khôi phục sẽ có lại ở các máy khác sau lần đồng bộ tiếp theo.
        </p>
        {notice && <p className="auth-success">{notice}</p>}
        {error && <p className="auth-error">{error}</p>}

        <div className="dialog__actions">
          <button type="button" className="auth-btn auth-btn--primary" onClick={onClose} autoFocus>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
