import { type FormEvent, useEffect, useState } from "react";
import { type CodeEntry, errorMessage, type Group } from "@auth/core";
import { Icon } from "@auth/ui";
import { api } from "../api";

interface Props {
  entry: CodeEntry;
  groups: Group[];
  onClose: () => void;
  /** Gọi sau khi lưu để màn hình chính tải lại (và tự đồng bộ). */
  onSaved: () => void;
}

/** Chọn các group cho một tài khoản (được chọn nhiều), tạo nhanh group mới. */
export function AccountGroupsDialog({ entry, groups: initialGroups, onClose, onSaved }: Props) {
  const [groups, setGroups] = useState(initialGroups);
  const [selected, setSelected] = useState<string[]>(entry.groupIds ?? []);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (id: string) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const group = await api.createGroup(newName);
      setGroups((gs) => [...gs, group].sort((a, b) => a.name.localeCompare(b.name)));
      setSelected((ids) => [...ids, group.id]);
      setNewName("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setAccountGroups(entry.id, selected);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Group của {entry.issuer || entry.label}</h2>

        {groups.length === 0 ? (
          <p className="auth-muted">Chưa có group nào. Tạo group đầu tiên ở dưới.</p>
        ) : (
          <ul className="group-checks">
            {groups.map((group) => (
              <li key={group.id}>
                <label className="group-check">
                  <input
                    type="checkbox"
                    checked={selected.includes(group.id)}
                    onChange={() => toggle(group.id)}
                  />
                  <span>{group.name}</span>
                  {group.hidden && <span className="auth-muted hint">(đang ẩn)</span>}
                </label>
              </li>
            ))}
          </ul>
        )}

        <form className="group-new" onSubmit={create}>
          <input
            className="auth-input"
            placeholder="Group mới"
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button className="auth-btn" disabled={busy || !newName.trim()}>
            <Icon name="plus" /> Tạo
          </button>
        </form>

        {error && <p className="auth-error">{error}</p>}
        <div className="dialog__actions">
          <button className="auth-btn" onClick={onClose}>
            Huỷ
          </button>
          <button className="auth-btn auth-btn--primary" onClick={() => void save()} disabled={busy}>
            Lưu
          </button>
        </div>
      </div>
    </div>
  );
}
