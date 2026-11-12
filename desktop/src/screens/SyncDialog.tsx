import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  isAppError,
  type AccountSummary,
  type PendingDeletion,
  type SyncPreview,
  type SyncResult,
} from "@auth/core";
import { api } from "../api";

interface Props {
  onClose: () => void;
  onSynced: (result: SyncResult) => void;
}

type State =
  | { step: "loading" }
  | { step: "password"; error: string | null }
  | { step: "review"; preview: SyncPreview }
  | { step: "error"; error: string };

const accountName = (a: { issuer: string; label: string }) =>
  a.issuer && a.label ? `${a.issuer} (${a.label})` : a.issuer || a.label;

const formatTime = (ms: number) => new Date(ms).toLocaleString("vi-VN");

/**
 * Đồng bộ 2 chiều với Google Drive. Không có gì cần hỏi thì đồng bộ luôn; có tài khoản bị xoá ở
 * một bên (hoặc cảnh báo về mật khẩu) thì hiện danh sách để người dùng xác nhận từng tài khoản.
 */
export function SyncDialog({ onClose, onSynced }: Props) {
  const [state, setState] = useState<State>({ step: "loading" });
  const [password, setPassword] = useState("");
  const [backupPassword, setBackupPassword] = useState<string | null>(null);
  /** id các tài khoản đồng ý xoá; bỏ chọn là giữ lại. */
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  // Màn hình cha render lại liên tục (đồng hồ mã OTP) nên callback đổi mỗi lần; giữ trong ref để
  // load/apply ổn định và chỉ xem trước một lần khi mở hộp thoại.
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  /** Máy khác vừa ghi bản sao lưu mới trong lúc xem trước: phải tải lại trước khi đồng bộ. */
  const [stale, setStale] = useState(false);

  const apply = useCallback(
    async (pw: string | null, ids: string[], version: string | null): Promise<boolean> => {
      setBusy(true);
      setApplyError(null);
      try {
        onSyncedRef.current(await api.googleSync(pw, ids, version));
        return true;
      } catch (e) {
        setApplyError(errorMessage(e));
        setStale(isAppError(e) && e.code === "BACKUP_CHANGED");
        setBusy(false);
        return false;
      }
    },
    [],
  );

  const load = useCallback(
    async (pw: string | null) => {
      setBusy(true);
      setApplyError(null);
      setStale(false);
      try {
        const preview = await api.googleSyncPreview(pw);
        setBackupPassword(pw);
        if (preview.pendingDeletions.length === 0 && preview.warnings.length === 0) {
          // Chỉ thêm tài khoản, không mất gì: đồng bộ luôn.
          setState({ step: "loading" });
          // Lỗi thì hiện bản xem trước kèm lỗi để người dùng thử lại.
          if (!(await apply(pw, [], preview.backupVersion))) setState({ step: "review", preview });
          return;
        }
        // Mặc định chỉ đánh dấu xoá những tài khoản chính máy này đã xoá; tài khoản bị xoá ở máy
        // khác được giữ lại trừ khi người dùng tự đánh dấu.
        setConfirmed(
          new Set(preview.pendingDeletions.filter((d) => d.side === "remote").map((d) => d.id)),
        );
        setState({ step: "review", preview });
      } catch (e) {
        if (isAppError(e) && e.code === "BACKUP_PASSWORD") {
          setState({ step: "password", error: null });
        } else if (isAppError(e) && e.code === "WRONG_PASSWORD" && pw !== null) {
          setState({ step: "password", error: e.message });
        } else {
          setState({ step: "error", error: errorMessage(e) });
        }
      }
      setBusy(false);
    },
    [apply],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const toggle = (id: string) =>
    setConfirmed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderBody = () => {
    switch (state.step) {
      case "loading":
        return (
          <p className="auth-muted sync-loading">
            <span className="spinner" /> Đang đồng bộ với Google Drive…
          </p>
        );

      case "error":
        return <p className="auth-error">{state.error}</p>;

      case "password":
        return (
          <form
            className="sync-password"
            onSubmit={(e) => {
              e.preventDefault();
              if (password) void load(password);
            }}
          >
            <p className="hint">
              Bản sao lưu trên Drive được mã hoá bằng master password khác với máy này. Nhập master
              password của bản sao lưu để gộp.
            </p>
            <input
              className="auth-input"
              type="password"
              placeholder="Master password của bản sao lưu"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            {state.error && <p className="auth-error">{state.error}</p>}
          </form>
        );

      case "review":
        return <Review preview={state.preview} confirmed={confirmed} onToggle={toggle} />;
    }
  };

  const review = state.step === "review" ? state.preview : null;
  const deleteCount = review?.pendingDeletions.filter((d) => confirmed.has(d.id)).length ?? 0;
  const keepCount = (review?.pendingDeletions.length ?? 0) - deleteCount;

  return (
    <div className="dialog-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="dialog dialog--wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Đồng bộ với Google Drive</h2>

        {renderBody()}
        {applyError && <p className="auth-error">{applyError}</p>}

        <div className="dialog__actions">
          <button type="button" className="auth-btn" onClick={onClose} disabled={busy}>
            {state.step === "error" ? "Đóng" : "Huỷ"}
          </button>
          {state.step === "error" && (
            <button type="button" className="auth-btn auth-btn--primary" onClick={() => void load(backupPassword)}>
              Thử lại
            </button>
          )}
          {state.step === "password" && (
            <button
              type="button"
              className="auth-btn auth-btn--primary"
              onClick={() => void load(password)}
              disabled={busy || !password}
            >
              {busy ? "Đang kiểm tra…" : "Tiếp tục"}
            </button>
          )}
          {review && (
            <button
              type="button"
              className={deleteCount > 0 ? "auth-btn auth-btn--danger" : "auth-btn auth-btn--primary"}
              onClick={() =>
                stale
                  ? void load(backupPassword)
                  : void apply(backupPassword, [...confirmed], review.backupVersion)
              }
              disabled={busy}
            >
              {busy
                ? "Đang đồng bộ…"
                : stale
                  ? "Tải lại"
                  : deleteCount > 0
                  ? `Đồng bộ (xoá ${deleteCount}${keepCount ? `, giữ ${keepCount}` : ""})`
                  : "Đồng bộ"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Review({
  preview,
  confirmed,
  onToggle,
}: {
  preview: SyncPreview;
  confirmed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const fromOther = preview.pendingDeletions.filter((d) => d.side === "local");
  const fromHere = preview.pendingDeletions.filter((d) => d.side === "remote");

  const nothing =
    preview.added.length + preview.uploaded.length + preview.pendingDeletions.length === 0;

  return (
    <>
      {nothing && <p className="auth-muted hint">Máy này và Google Drive đã giống nhau.</p>}
      {preview.warnings.map((w) => (
        <p key={w} className="sync-warning">
          ⚠ {w}
        </p>
      ))}

      <Summary title="Thêm vào máy này" accounts={preview.added} />
      <Summary title="Đưa lên Google Drive" accounts={preview.uploaded} />

      {fromOther.length > 0 && (
        <DeletionGroup
          title="Đã bị xoá ở máy khác. Đánh dấu để xoá khỏi máy này:"
          items={fromOther}
          confirmed={confirmed}
          onToggle={onToggle}
        />
      )}
      {fromHere.length > 0 && (
        <DeletionGroup
          title="Bạn đã xoá trên máy này. Đánh dấu để xoá khỏi bản sao lưu:"
          items={fromHere}
          confirmed={confirmed}
          onToggle={onToggle}
        />
      )}
      {preview.pendingDeletions.length > 0 && (
        <p className="auth-muted hint">
          Tài khoản không đánh dấu được giữ lại ở mọi máy. Tài khoản bị xoá vẫn nằm trong Thùng rác
          và khôi phục được; bản vault trước khi đồng bộ cũng được lưu trong thư mục history.
        </p>
      )}
    </>
  );
}

function Summary({ title, accounts }: { title: string; accounts: AccountSummary[] }) {
  if (accounts.length === 0) return null;
  return (
    <p className="hint">
      <strong>
        {title}: {accounts.length} tài khoản
      </strong>{" "}
      <span className="auth-muted">
        ({accounts.slice(0, 3).map(accountName).join(", ")}
        {accounts.length > 3 ? `, và ${accounts.length - 3} tài khoản khác` : ""})
      </span>
    </p>
  );
}

function DeletionGroup({
  title,
  items,
  confirmed,
  onToggle,
}: {
  title: string;
  items: PendingDeletion[];
  confirmed: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="sync-group">
      <p className="hint">
        <strong>{title}</strong>
      </p>
      <ul className="preview-list">
        {items.map((item) => {
          const remove = confirmed.has(item.id);
          return (
            <li key={item.id} className="preview-item">
              <label className="sync-item">
                <input type="checkbox" checked={remove} onChange={() => onToggle(item.id)} />
                <span className="preview-item__name">
                  <strong>{item.issuer || item.label}</strong>
                  <span className="auth-muted">
                    {item.issuer && item.label ? `${item.label} · ` : ""}xoá lúc{" "}
                    {formatTime(item.deletedAt)}
                  </span>
                </span>
              </label>
              <span className={remove ? "badge badge--danger" : "badge"}>
                {remove ? (item.permanent ? "Xoá vĩnh viễn" : "Xoá") : "Giữ lại"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
