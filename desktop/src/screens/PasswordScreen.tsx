import { useState, type FormEvent } from "react";
import { errorMessage } from "@auth/core";
import { api } from "../api";

const MIN_LENGTH = 8;

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (isSetup) {
      if (password.length < MIN_LENGTH) {
        return setError(`Mật khẩu cần ít nhất ${MIN_LENGTH} ký tự.`);
      }
      if (password !== confirm) {
        return setError("Mật khẩu nhập lại không khớp.");
      }
    }

    setBusy(true);
    setError(null);
    try {
      await (isSetup ? api.createVault(password) : api.unlockVault(password));
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="page page--center">
      <form className="password-form" onSubmit={submit}>
        <h1>🔐 Authenticator</h1>
        <p className="auth-muted">
          {isSetup
            ? "Tạo master password để mã hoá vault. Nếu quên mật khẩu, bạn sẽ không khôi phục được dữ liệu."
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
          {busy ? "Đang xử lý..." : isSetup ? "Tạo vault" : "Mở khoá"}
        </button>
      </form>
    </main>
  );
}
