import { useEffect, useState, type FormEvent } from "react";
import { errorMessage, MIN_PASSWORD_LENGTH } from "@auth/core";
import { Icon } from "@auth/ui";
import { api } from "../api";

interface Props {
  hasPassword: boolean;
  onChanged: () => void;
  onClose: () => void;
}

/** Modal đặt, đổi hoặc bỏ master password. */
export function SecurityDialog({ hasPassword, onChanged, onClose }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Esc để đóng (trừ khi đang lưu).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const apply = async (newPassword: string | null) => {
    if (newPassword !== null) {
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return setError(`Mật khẩu cần ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
      }
      if (newPassword !== confirm) {
        return setError("Mật khẩu nhập lại không khớp.");
      }
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await api.setPassword(hasPassword ? current : null, newPassword);
      setCurrent("");
      setNext("");
      setConfirm("");
      setSuccess(newPassword === null ? "Đã bỏ master password." : "Đã lưu master password.");
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void apply(next);
  };

  return (
    <div className="dialog-backdrop" onMouseDown={() => !busy && onClose()}>
      <form className="dialog" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Bảo mật</h2>
        <p className="auth-muted security-status">
          {hasPassword ? (
            <>
              <Icon name="lock" /> Vault đang được bảo vệ bằng master password.
            </>
          ) : (
            <>
              <Icon name="lock-open" /> Không dùng mật khẩu: vault tự mở khoá bằng tài khoản
              Windows của bạn.
            </>
          )}
        </p>

        {hasPassword && (
          <input
            className="auth-input"
            type="password"
            placeholder="Mật khẩu hiện tại"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoFocus
          />
        )}
        <input
          className="auth-input"
          type="password"
          placeholder={hasPassword ? "Mật khẩu mới" : "Master password"}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoFocus={!hasPassword}
        />
        <input
          className="auth-input"
          type="password"
          placeholder="Nhập lại mật khẩu"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />

        {error && <p className="auth-error">{error}</p>}
        {success && <p className="auth-success">{success}</p>}

        <div className="dialog__actions">
          {hasPassword && (
            <button
              type="button"
              className="auth-btn auth-btn--danger dialog__action-left"
              disabled={busy || !current}
              onClick={() => void apply(null)}
            >
              Bỏ mật khẩu
            </button>
          )}
          <button type="button" className="auth-btn" onClick={onClose} disabled={busy}>
            Đóng
          </button>
          <button className="auth-btn auth-btn--primary" disabled={busy || !next}>
            {busy ? "Đang lưu..." : hasPassword ? "Đổi mật khẩu" : "Đặt mật khẩu"}
          </button>
        </div>
      </form>
    </div>
  );
}
