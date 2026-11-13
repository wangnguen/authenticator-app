import { type FormEvent, useCallback, useEffect, useState } from "react";
import { errorMessage, type Group } from "@auth/core";
import { Icon } from "@auth/ui";
import { api } from "../api";

interface Props {
  onClose: () => void;
  /** Gọi sau mỗi thay đổi để màn hình chính tải lại (và tự đồng bộ). */
  onChanged: () => void;
}

/** Quản lý group: tạo, đổi tên, ẩn/hiện, xoá (tài khoản trong group vẫn còn). */
export function GroupsDialog({ onClose, onChanged }: Props) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setGroups(await api.listGroups());
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

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.createGroup(newName))) setNewName("");
  };

  const saveName = async () => {
    if (!editing) return;
    const group = groups?.find((g) => g.id === editing.id);
    if (!group || group.name === editing.name.trim()) {
      setEditing(null);
      return;
    }
    if (await run(() => api.renameGroup(editing.id, editing.name))) setEditing(null);
  };

  const remove = (group: Group) => {
    if (confirmDelete !== group.id) {
      setConfirmDelete(group.id);
      return;
    }
    setConfirmDelete(null);
    void run(() => api.deleteGroup(group.id));
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog dialog--wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Group</h2>
        <p className="auth-muted hint">
          Một tài khoản có thể thuộc nhiều group. Group <strong>ẩn</strong>: tài khoản chỉ thuộc
          các group ẩn không hiện ở "Tất cả" (cả trong extension); tìm kiếm vẫn thấy.
        </p>

        <form className="group-new" onSubmit={create}>
          <input
            className="auth-input"
            placeholder="Tên group mới (vd: Công việc)"
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <button className="auth-btn auth-btn--primary" disabled={busy || !newName.trim()}>
            <Icon name="plus" /> Tạo
          </button>
        </form>

        {groups === null ? (
          <p className="auth-muted">Đang tải...</p>
        ) : groups.length === 0 ? (
          <p className="auth-empty">Chưa có group nào.</p>
        ) : (
          <ul className="group-list">
            {groups.map((group) => (
              <li key={group.id} className="group-item">
                {editing?.id === group.id ? (
                  <input
                    className="auth-input group-item__name"
                    value={editing.name}
                    maxLength={40}
                    onChange={(e) => setEditing({ id: group.id, name: e.target.value })}
                    onBlur={() => void saveName()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveName();
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    autoFocus
                  />
                ) : (
                  <button
                    className="group-item__name group-item__label"
                    onClick={() => setEditing({ id: group.id, name: group.name })}
                    title="Bấm để đổi tên"
                  >
                    <strong>{group.name}</strong>
                    <span className="auth-muted"> · {group.count} tài khoản</span>
                  </button>
                )}
                <button
                  className={group.hidden ? "auth-btn auth-btn--small group-hidden" : "auth-btn auth-btn--small"}
                  onClick={() => void run(() => api.setGroupHidden(group.id, !group.hidden))}
                  disabled={busy}
                  title={group.hidden ? "Đang ẩn, bấm để hiện" : "Đang hiện, bấm để ẩn"}
                >
                  <Icon name={group.hidden ? "eye-off" : "eye"} /> {group.hidden ? "Đang ẩn" : "Hiện"}
                </button>
                <button
                  className="auth-btn auth-btn--small auth-btn--danger"
                  onClick={() => remove(group)}
                  onBlur={() => setConfirmDelete(null)}
                  disabled={busy}
                  title="Xoá group (tài khoản trong group vẫn còn)"
                >
                  {confirmDelete === group.id ? "Xác nhận?" : "Xoá"}
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="auth-error">{error}</p>}
        <div className="dialog__actions">
          <button className="auth-btn" onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
