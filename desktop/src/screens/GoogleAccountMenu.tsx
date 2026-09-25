import { useEffect, useRef, useState } from "react";
import { errorMessage, type BackupInfo, type GoogleProfile } from "@auth/core";
import { api } from "../api";

interface Props {
  /** Có mật khẩu: sao lưu bản mã hoá. Không mật khẩu: sao lưu JSON không mã hoá. */
  hasPassword: boolean;
  /** Gọi sau khi khôi phục xong (bản mã hoá thì vault bị khoá, cần master password). */
  onRestored: () => void;
}

type Busy = "signin" | "backup" | "folder" | "restore" | "signout" | null;
type Message = { kind: "success" | "error"; text: string } | null;

export function formatBackupTime(info: BackupInfo | null): string {
  if (!info?.modifiedTime) return "Chưa có bản sao lưu";
  return `Sao lưu lúc ${new Date(info.modifiedTime).toLocaleString("vi-VN")}`;
}

export function GoogleLogo() {
  return (
    <svg className="google-logo" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function Avatar({ profile }: { profile: GoogleProfile }) {
  const [broken, setBroken] = useState(false);
  if (profile.picture && !broken) {
    return (
      <img
        className="avatar"
        src={profile.picture}
        alt={profile.name}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return <span className="avatar avatar--letter">{profile.name.charAt(0).toUpperCase()}</span>;
}

/** Nút đăng nhập Google ở góc phải; đăng nhập rồi thì là avatar mở menu sao lưu. */
export function GoogleAccountMenu({ hasPassword, onRestored }: Props) {
  const [profile, setProfile] = useState<GoogleProfile | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [backup, setBackup] = useState<BackupInfo | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.googleAccount().then(setProfile, () => setProfile(null));
  }, []);

  useEffect(() => {
    if (!open || !profile) return;
    api.googleBackupInfo().then(setBackup, (e) =>
      setMessage({ kind: "error", text: errorMessage(e) }),
    );
  }, [open, profile]);

  // Đóng menu khi bấm ra ngoài.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirmRestore(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const run = async (kind: Busy, action: () => Promise<string | void>) => {
    setBusy(kind);
    setMessage(null);
    try {
      const text = await action();
      if (text) setMessage({ kind: "success", text });
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
      setOpen(true);
    } finally {
      setBusy(null);
    }
  };

  const signIn = () =>
    run("signin", async () => {
      setProfile(await api.googleSignIn());
      setOpen(true);
      return "Đã đăng nhập Google.";
    });

  const doBackup = () =>
    run("backup", async () => {
      setBackup(await api.googleBackup());
      return "Đã sao lưu vault lên Google Drive.";
    });

  const openFolder = () => run("folder", () => api.googleOpenBackupFolder());

  const doRestore = () =>
    run("restore", async () => {
      await api.googleRestore();
      setOpen(false);
      setConfirmRestore(false);
      onRestored();
    });

  const signOut = () =>
    run("signout", async () => {
      await api.googleSignOut();
      setProfile(null);
      setBackup(null);
      setOpen(false);
    });

  if (profile === undefined) return null;

  return (
    <div className="google-menu" ref={rootRef}>
      {profile ? (
        <button
          className="avatar-btn"
          onClick={() => setOpen((v) => !v)}
          title={`${profile.name} (${profile.email})`}
        >
          <Avatar profile={profile} />
        </button>
      ) : (
        <button
          className="auth-btn google-icon-btn"
          onClick={signIn}
          disabled={busy === "signin"}
          title={busy === "signin" ? "Đang chờ đăng nhập trên trình duyệt…" : "Đăng nhập Google"}
        >
          {busy === "signin" ? <span className="spinner" /> : <GoogleLogo />}
        </button>
      )}

      {open && (
        <div className="google-menu__panel">
          {profile && (
            <>
              <div className="google-menu__profile">
                <Avatar profile={profile} />
                <div>
                  <strong>{profile.name}</strong>
                  <span className="auth-muted">{profile.email}</span>
                </div>
              </div>

              <p className="auth-muted hint">{formatBackupTime(backup)}</p>

              <button
                className="auth-btn auth-btn--primary"
                onClick={doBackup}
                disabled={busy !== null}
                title={
                  hasPassword
                    ? "Lưu bản đã mã hoá bằng master password vào thư mục Authenticator Backup"
                    : "Vault không mật khẩu: bản sao lưu là JSON không mã hoá, ai mở được file trên Drive cũng thấy secret"
                }
              >
                {busy === "backup" ? "Đang sao lưu…" : "☁ Sao lưu lên Google Drive"}
              </button>

              <button className="auth-btn" onClick={openFolder} disabled={busy !== null}>
                {busy === "folder" ? "Đang mở…" : "📂 Mở thư mục trên Drive"}
              </button>

              {confirmRestore ? (
                <div className="confirm-box">
                  <p className="hint">
                    Toàn bộ tài khoản trên máy này sẽ được thay bằng bản sao lưu (bản hiện tại vẫn
                    được giữ ở vault.json.bak).
                  </p>
                  <div className="panel__actions">
                    <button className="auth-btn" onClick={() => setConfirmRestore(false)}>
                      Huỷ
                    </button>
                    <button
                      className="auth-btn auth-btn--danger"
                      onClick={doRestore}
                      disabled={busy !== null}
                    >
                      {busy === "restore" ? "Đang khôi phục…" : "Khôi phục"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="auth-btn"
                  onClick={() => setConfirmRestore(true)}
                  disabled={busy !== null || !backup?.modifiedTime}
                >
                  ⤓ Khôi phục từ Google Drive
                </button>
              )}
            </>
          )}

          {message && (
            <p className={message.kind === "success" ? "auth-success" : "auth-error"}>
              {message.text}
            </p>
          )}

          {profile && (
            <button className="auth-btn auth-btn--small" onClick={signOut} disabled={busy !== null}>
              Đăng xuất
            </button>
          )}
        </div>
      )}
    </div>
  );
}
