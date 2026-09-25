import { useState, type FormEvent } from "react";
import { errorMessage, MIN_PASSWORD_LENGTH } from "@auth/core";
import { Icon } from "@auth/ui";
import { api } from "../api";
import { RestoreFromGoogle } from "./RestoreFromGoogle";

interface Props {
  mode: "setup" | "unlock";
  onDone: () => void;
}

export function PasswordScreen({ mode, onDone }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSetup = mode === "setup";

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (isSetup) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        return setError(`Mật khẩu cần ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`);
      }
      if (password !== confirm) {
        return setError("Mật khẩu nhập lại không khớp.");
      }
    }
    void run(() => (isSetup ? api.createVault(password) : api.unlockVault(password)));
  };

  return (
    <main className="page page--center">
      <form className="password-form" onSubmit={submit}>
        <h1>
          <Icon name="shield-lock" size={24} /> Authenticator
        </h1>
        <p className="auth-muted">
          {isSetup
            ? "Đặt master password để bảo vệ vault (tuỳ chọn). Nếu quên mật khẩu, bạn sẽ không khôi phục được dữ liệu."
            : "Nhập master password để mở khoá vault."}
        </p>
        <input
          className="auth-input"
          type="password"
          placeholder="Master password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {isSetup && (
          <input
            className="auth-input"
            type="password"
            placeholder="Nhập lại mật khẩu"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
        {error && <p className="auth-error">{error}</p>}
        <button className="auth-btn auth-btn--primary" disabled={busy || !password}>
          {busy ? "Đang xử lý..." : isSetup ? "Tạo vault có mật khẩu" : "Mở khoá"}
        </button>

        {isSetup && (
          <>
            <div className="divider">hoặc</div>
            <button
              type="button"
              className="auth-btn"
              disabled={busy}
              onClick={() => void run(() => api.createVault(null))}
            >
              Không dùng mật khẩu
            </button>
            <p className="auth-muted hint">
              Vault tự mở khoá khi bạn đăng nhập Windows. Ai dùng được tài khoản Windows của
              bạn cũng xem được mã. Bạn có thể đặt mật khẩu sau trong <Icon name="settings" /> Bảo mật.
            </p>
            <div className="divider">đã có bản sao lưu?</div>
            <RestoreFromGoogle onRestored={onDone} />
          </>
        )}
      </form>
    </main>
  );
}
