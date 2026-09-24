import { useEffect, useState } from "react";
import { errorMessage } from "@auth/core";
import { api } from "./api";
import { PasswordScreen } from "./screens/PasswordScreen";
import { VaultScreen } from "./screens/VaultScreen";

type Screen = "loading" | "setup" | "unlock" | "vault";

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .status()
      .then((s) => setScreen(!s.exists ? "setup" : s.unlocked ? "vault" : "unlock"))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) {
    return (
      <main className="page page--center">
        <p className="auth-error">{error}</p>
      </main>
    );
  }

  switch (screen) {
    case "loading":
      return <main className="page page--center auth-muted">Đang tải...</main>;
    case "setup":
    case "unlock":
      return <PasswordScreen mode={screen} onDone={() => setScreen("vault")} />;
    case "vault":
      return (
        <VaultScreen
          onLock={async () => {
            await api.lockVault();
            setScreen("unlock");
          }}
        />
      );
  }
}
