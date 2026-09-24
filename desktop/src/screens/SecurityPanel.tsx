import { useState, type FormEvent } from "react";
import { errorMessage, MIN_PASSWORD_LENGTH } from "@auth/core";
import { api } from "../api";

interface Props {
  hasPassword: boolean;
  onChanged: () => void;
}

/** Đặt, đổi hoặc bỏ master password. */
export function SecurityPanel({ hasPassword, onChanged }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <form className="panel" onSubmit={submit}>
      <h3>Bảo mật</h3>
      <p className="auth-muted">
        {hasPassword
          ? "🔐 Vault đang được bảo vệ bằng master password."
          : "🔓 Không dùng mật khẩu: vault tự mở khoá bằng tài khoản Windows của bạn."}
      </p>

      {hasPassword && (
        <input
          className="auth-input"
          type="password"
          placeholder="Mật khẩu hiện tại"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      )}
      <input
        className="auth-input"
        type="password"
        placeholder={hasPassword ? "Mật khẩu mới" : "Master password"}
        value={next}
        onChange={(e) => setNext(e.target.value)}
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

      <div className="panel__actions">
        {hasPassword && (
          <button
            type="button"
            className="auth-btn auth-btn--danger"
            disabled={busy || !current}
            onClick={() => void apply(null)}
          >
            Bỏ mật khẩu
          </button>
        )}
        <button className="auth-btn auth-btn--primary" disabled={busy || !next}>
          {busy ? "Đang lưu..." : hasPassword ? "Đổi mật khẩu" : "Đặt mật khẩu"}
        </button>
      </div>
    </form>
  );
}
