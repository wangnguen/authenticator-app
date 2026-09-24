import { useCallback, useEffect, useState } from "react";
import { errorMessage, type VaultStatus } from "@auth/core";
import { api } from "./api";
import { PasswordScreen } from "./screens/PasswordScreen";
import { VaultScreen } from "./screens/VaultScreen";

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      let next = await api.status();
      // Vault không mật khẩu: mở khoá luôn (ví dụ sau khi bấm khoá).
      if (next.exists && !next.unlocked && !next.hasPassword) {
        await api.unlockVault(null);
        next = await api.status();
      }
      setStatus(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <main className="page page--center">
        <p className="auth-error">{error}</p>
      </main>
    );
  }
  if (!status) {
    return <main className="page page--center auth-muted">Đang tải...</main>;
  }
  if (!status.exists) {
    return <PasswordScreen mode="setup" onDone={load} />;
  }
  if (!status.unlocked) {
    return <PasswordScreen mode="unlock" onDone={load} />;
  }
  return (
    <VaultScreen
      hasPassword={status.hasPassword}
      onLock={async () => {
        await api.lockVault();
        await load();
      }}
      onSecurityChanged={load}
    />
  );
}
