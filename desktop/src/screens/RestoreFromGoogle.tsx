import { useState } from "react";
import { errorMessage, type BackupInfo, type GoogleProfile } from "@auth/core";
import { api } from "../api";
import { formatBackupTime, GoogleLogo } from "./GoogleAccountMenu";

interface Props {
  /** Gọi sau khi khôi phục xong: vault đã có trên máy, đang khoá. */
  onRestored: () => void;
}

/** Máy mới / cài lại Windows: lấy lại vault từ bản sao lưu trên Google Drive. */
export function RestoreFromGoogle({ onRestored }: Props) {
  const [found, setFound] = useState<{ profile: GoogleProfile; backup: BackupInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const findBackup = () =>
    run(async () => {
      const profile = (await api.googleAccount()) ?? (await api.googleSignIn());
      const backup = await api.googleBackupInfo();
      if (!backup) throw new Error(`Tài khoản ${profile.email} chưa có bản sao lưu nào.`);
      setFound({ profile, backup });
    });

  const restore = () =>
    run(async () => {
      await api.googleRestore();
      onRestored();
    });

  if (!found) {
    return (
      <>
        <button type="button" className="auth-btn google-btn" disabled={busy} onClick={findBackup}>
          <GoogleLogo />
          {busy ? "Đang chờ Google…" : "Khôi phục từ Google Drive"}
        </button>
        {error && <p className="auth-error">{error}</p>}
      </>
    );
  }

  return (
    <div className="confirm-box">
      <p className="hint">
        {found.profile.email}: {formatBackupTime(found.backup).toLowerCase()}. Nếu bản sao lưu có
        master password thì cần nhập nó để mở.
      </p>
      {error && <p className="auth-error">{error}</p>}
      <div className="panel__actions">
        <button type="button" className="auth-btn" onClick={() => setFound(null)} disabled={busy}>
          Huỷ
        </button>
        <button type="button" className="auth-btn auth-btn--primary" onClick={restore} disabled={busy}>
          {busy ? "Đang khôi phục…" : "Khôi phục"}
        </button>
      </div>
    </div>
  );
}
