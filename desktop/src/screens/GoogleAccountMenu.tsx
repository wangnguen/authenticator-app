import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  isAppError,
  type BackupInfo,
  type GoogleProfile,
  type RestorePreview,
  type SyncResult,
} from "@auth/core";
import { Icon } from "@auth/ui";
import { api } from "../api";
import { SyncDialog } from "./SyncDialog";

interface Props {
  /** Có mật khẩu: sao lưu bản mã hoá. Không mật khẩu: sao lưu JSON không mã hoá. */
  hasPassword: boolean;
  /** Gọi sau khi khôi phục xong (bản mã hoá thì vault bị khoá, cần master password). */
  onRestored: () => void;
  /** Gọi sau khi đồng bộ xong để tải lại danh sách mã và Thùng rác. */
  onSynced: () => void;
  /** Tăng mỗi khi vault trên máy thay đổi (thêm/xoá/khôi phục): tự đồng bộ sau vài giây. */
  changeCount: number;
  /** Tăng khi người dùng bấm "Xem" trên thanh báo đồng bộ. */
  attentionRequest: number;
  /** Báo cho màn hình chính hiện (hoặc ẩn khi null) thanh báo đồng bộ cần người dùng xử lý. */
  onAttention: (text: string | null) => void;
}

/** Chờ sau thay đổi cuối cùng rồi mới tự đồng bộ (gộp nhiều thay đổi liên tiếp). */
const AUTO_SYNC_DELAY_MS = 2000;
/** Tự đồng bộ định kỳ để nhận thay đổi từ máy khác khi app chạy nền. */
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/** Việc cần người dùng làm: mở hộp thoại đồng bộ, hoặc đăng nhập lại Google. */
type Attention = { text: string; action: "sync" | "signin" } | null;

type Busy = "signin" | "folder" | "restore-check" | "restore" | "signout" | null;

/** Số tài khoản bị mất tối đa liệt kê trong hộp xác nhận khôi phục. */
const MISSING_SHOWN = 5;

function syncMessage(result: SyncResult): string {
  const parts = [
    result.added && `thêm ${result.added} tài khoản từ Drive`,
    result.uploaded && `đưa ${result.uploaded} tài khoản lên Drive`,
    result.deleted && `xoá ${result.deleted} tài khoản (vẫn còn trong Thùng rác)`,
    result.kept && `giữ lại ${result.kept} tài khoản`,
  ].filter(Boolean);
  return parts.length ? `Đã đồng bộ: ${parts.join(", ")}.` : "Đã đồng bộ, không có thay đổi.";
}
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
export function GoogleAccountMenu({
  hasPassword,
  onRestored,
  onSynced,
  changeCount,
  attentionRequest,
  onAttention,
}: Props) {
  const [profile, setProfile] = useState<GoogleProfile | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [backup, setBackup] = useState<BackupInfo | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [attention, setAttentionState] = useState<Attention>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Callback của màn hình cha đổi mỗi lần render: giữ trong ref để tự đồng bộ không chạy lại vô cớ.
  const callbacks = useRef({ onSynced, onAttention });
  callbacks.current = { onSynced, onAttention };
  const syncingRef = useRef(syncing);
  syncingRef.current = syncing;
  const autoRunning = useRef(false);

  const setAttention = useCallback((next: Attention) => {
    setAttentionState(next);
    callbacks.current.onAttention(next?.text ?? null);
  }, []);

  /**
   * Tự đồng bộ: chỉ chạy khi không có gì phải hỏi. Tài khoản chính máy này đã xoá thì đồng bộ luôn
   * (người dùng đã xác nhận lúc bấm Xoá); tài khoản bị xoá ở máy khác hoặc cảnh báo về mật khẩu
   * thì hiện thanh báo để người dùng tự mở hộp thoại xác nhận.
   */
  const autoSync = useCallback(async () => {
    if (syncingRef.current || autoRunning.current) return;
    autoRunning.current = true;
    try {
      const preview = await api.googleSyncPreview(null);
      if (preview.inSync) {
        setAttention(null);
        return;
      }
      const fromOther = preview.pendingDeletions.filter((d) => d.side === "local");
      if (fromOther.length > 0 || preview.warnings.length > 0) {
        setAttention({
          text:
            fromOther.length > 0
              ? `${fromOther.length} tài khoản đã bị xoá ở máy khác. Cần bạn xác nhận trước khi đồng bộ.`
              : "Đồng bộ với Google Drive cần bạn xem lại trước khi tiếp tục.",
          action: "sync",
        });
        return;
      }
      const ownDeletions = preview.pendingDeletions.map((d) => d.id);
      const result = await api.googleSync(null, ownDeletions, preview.backupVersion);
      setBackup(result.backup);
      setAttention(null);
      // Gộp có thể đổi cả Thùng rác hay tài khoản đang có, không chỉ thêm mới: luôn tải lại.
      callbacks.current.onSynced();
    } catch (e) {
      if (!isAppError(e)) return;
      if (e.code === "BACKUP_PASSWORD") {
        setAttention({
          text: "Bản sao lưu trên Drive dùng master password khác. Mở đồng bộ để nhập mật khẩu.",
          action: "sync",
        });
      } else if (e.code === "GOOGLE_SESSION_EXPIRED" || e.code === "GOOGLE_SIGNED_OUT") {
        // App đã tự đăng xuất phiên hỏng: hiện lại nút đăng nhập.
        setProfile(null);
        setAttention({ text: `${e.message} Đồng bộ tạm dừng.`, action: "signin" });
      }
      // Lỗi mạng, máy khác vừa ghi (BACKUP_CHANGED)...: im lặng, lần sau thử lại.
    } finally {
      autoRunning.current = false;
    }
  }, [setAttention]);

  // Mở app và sau mỗi thay đổi trên máy.
  useEffect(() => {
    if (!profile) return;
    const timer = setTimeout(() => void autoSync(), changeCount === 0 ? 0 : AUTO_SYNC_DELAY_MS);
    return () => clearTimeout(timer);
  }, [profile, changeCount, autoSync]);

  // Định kỳ, để nhận thay đổi từ máy khác khi app chạy nền ở tray.
  useEffect(() => {
    if (!profile) return;
    const timer = setInterval(() => void autoSync(), AUTO_SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [profile, autoSync]);

  // Người dùng bấm "Xem" trên thanh báo.
  const attentionRef = useRef(attention);
  attentionRef.current = attention;
  useEffect(() => {
    if (attentionRequest === 0) return;
    if (attentionRef.current?.action === "signin") {
      void signIn();
    } else {
      setOpen(false);
      setMessage(null);
      setSyncing(true);
    }
  }, [attentionRequest]);

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
        setRestorePreview(null);
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
      setAttention(null);
      setOpen(true);
      return "Đã đăng nhập Google.";
    });

  const synced = (result: SyncResult) => {
    setSyncing(false);
    setAttention(null);
    setBackup(result.backup);
    setMessage({ kind: "success", text: syncMessage(result) });
    setOpen(true);
    onSynced();
  };

  const checkRestore = () =>
    run("restore-check", async () => {
      setRestorePreview(await api.googleRestorePreview());
    });

  const openFolder = () => run("folder", () => api.googleOpenBackupFolder());

  const doRestore = () =>
    run("restore", async () => {
      if (!restorePreview) return;
      try {
        await api.googleRestore(restorePreview.backupVersion);
      } catch (e) {
        // Bản trên Drive đổi sau lúc so sánh: bỏ kết quả so sánh cũ để người dùng xem lại.
        if (isAppError(e) && e.code === "BACKUP_CHANGED") setRestorePreview(null);
        throw e;
      }
      setOpen(false);
      setRestorePreview(null);
      onRestored();
    });

  const signOut = () =>
    run("signout", async () => {
      await api.googleSignOut();
      setAttention(null);
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
          title={attention ? attention.text : `${profile.name} (${profile.email})`}
        >
          <Avatar profile={profile} />
          {attention && <span className="avatar-dot" />}
        </button>
      ) : (
        <button
          className="auth-btn auth-btn--icon google-icon-btn"
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
                onClick={() => {
                  // Đóng panel (z-index cao) để không đè lên hộp thoại đồng bộ.
                  setOpen(false);
                  setMessage(null);
                  setSyncing(true);
                }}
                disabled={busy !== null || syncing}
                title={
                  hasPassword
                    ? "Gộp tài khoản giữa máy này và bản sao lưu (mã hoá bằng master password)"
                    : "Vault không mật khẩu: bản sao lưu là JSON không mã hoá, ai mở được file trên Drive cũng thấy secret"
                }
              >
                <Icon name="sync" /> Đồng bộ với Google Drive
              </button>

              <button className="auth-btn" onClick={openFolder} disabled={busy !== null}>
                {busy === "folder" ? (
                  "Đang mở…"
                ) : (
                  <>
                    <Icon name="folder-open" /> Mở thư mục trên Drive
                  </>
                )}
              </button>

              {restorePreview ? (
                <RestoreConfirm
                  preview={restorePreview}
                  busy={busy === "restore"}
                  onCancel={() => setRestorePreview(null)}
                  onConfirm={doRestore}
                />
              ) : (
                <button
                  className="auth-btn"
                  onClick={checkRestore}
                  disabled={busy !== null || !backup?.modifiedTime}
                  title="Thay toàn bộ tài khoản trên máy này bằng bản sao lưu"
                >
                  {busy === "restore-check" ? (
                    "Đang so sánh…"
                  ) : (
                    <>
                      <Icon name="download" /> Khôi phục từ Google Drive
                    </>
                  )}
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

      {syncing && <SyncDialog onClose={() => setSyncing(false)} onSynced={synced} />}
    </div>
  );
}

function RestoreConfirm({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: RestorePreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const missing = preview.missing ?? [];
  return (
    <div className="confirm-box">
      <p className="hint">
        Khôi phục sẽ <strong>thay toàn bộ</strong> {preview.localCount} tài khoản trên máy này bằng
        bản sao lưu
        {preview.backupCount !== null && ` (${preview.backupCount} tài khoản)`}.
      </p>
      {missing.length > 0 && (
        <div className="sync-warning">
          <p className="hint">
            ⚠ {missing.length} tài khoản trên máy này không có trong bản sao lưu và sẽ mất khỏi danh
            sách:
          </p>
          <ul className="restore-missing">
            {missing.slice(0, MISSING_SHOWN).map((a) => (
              <li key={a.id}>{a.issuer && a.label ? `${a.issuer} (${a.label})` : a.issuer || a.label}</li>
            ))}
            {missing.length > MISSING_SHOWN && <li>và {missing.length - MISSING_SHOWN} tài khoản khác</li>}
          </ul>
          <p className="hint">Muốn giữ cả hai bên thì dùng <strong>Đồng bộ</strong> thay vì khôi phục.</p>
        </div>
      )}
      {preview.warnings.map((w) => (
        <p key={w} className="sync-warning hint">
          ⚠ {w}
        </p>
      ))}
      <p className="auth-muted hint">
        Vault hiện tại được lưu trong thư mục history (10 bản gần nhất) để lấy lại khi cần.
      </p>
      <div className="panel__actions">
        <button className="auth-btn" onClick={onCancel} disabled={busy}>
          Huỷ
        </button>
        <button className="auth-btn auth-btn--danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Đang khôi phục…" : missing.length > 0 ? "Vẫn khôi phục" : "Khôi phục"}
        </button>
      </div>
    </div>
  );
}
