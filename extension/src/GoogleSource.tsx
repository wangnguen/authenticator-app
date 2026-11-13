import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { errorMessage, type GoogleProfile, isAppError, type PendingDeletion } from "@auth/core";
import { Codes } from "./Codes";
import { MIN_PASSWORD_LEN } from "./standalone/backup";
import { googleConfigured, googleProfile, signOut } from "./standalone/google";
import { requestSignIn } from "./standalone/messages";
import {
  applySync,
  type Attention,
  attention as readAttention,
  autoSync,
  createVault,
  forget,
  importUris,
  listCodes,
  listGroups,
  lock,
  type PreparedSync,
  prepareSync,
  type StandaloneStatus,
  standaloneStatus,
  unlock,
} from "./standalone/vault";

type View =
  | { kind: "loading" }
  | { kind: "signin" }
  /** Lần đầu tải bản sao lưu có master password. */
  | { kind: "first-password" }
  /** Drive chưa có bản sao lưu. */
  | { kind: "create" }
  | { kind: "locked" }
  /** Bản sao lưu đã đổi master password (trên app). */
  | { kind: "backup-password" }
  | { kind: "review"; sync: PreparedSync }
  | { kind: "codes" };

const errorCode = (e: unknown) => (isAppError(e) ? e.code : null);

/** Đồng bộ trực tiếp với Google Drive, không cần app desktop. */
export function GoogleSource() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [profile, setProfile] = useState<GoogleProfile | null>(null);
  const [status, setStatus] = useState<StandaloneStatus | null>(null);
  const [attention, setAttention] = useState<Attention | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Đổi để tải lại danh sách mã sau khi đồng bộ. */
  const [codesKey, setCodesKey] = useState(0);

  /** Lần đầu: tải dữ liệu từ Drive về extension. */
  const firstSync = useCallback(async (password?: string) => {
    const sync = await prepareSync(password);
    if (!("plan" in sync)) {
      setView({ kind: sync.kind === "create" ? "create" : "first-password" });
      return;
    }
    await applySync(sync, []);
    setStatus(await standaloneStatus());
    setView({ kind: "codes" });
  }, []);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      setAttention(await autoSync());
      setStatus(await standaloneStatus());
      setCodesKey((k) => k + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const signedIn = await googleProfile();
      setProfile(signedIn);
      if (!signedIn) {
        setView({ kind: "signin" });
        return;
      }
      const current = await standaloneStatus();
      setStatus(current);
      setAttention(await readAttention());
      if (current.state === "empty") {
        setView({ kind: "loading" });
        await firstSync();
      } else if (current.state === "locked") {
        setView({ kind: "locked" });
      } else {
        setView({ kind: "codes" });
        void syncNow();
      }
    } catch (e) {
      const code = errorCode(e);
      if (code === "GOOGLE_SESSION_EXPIRED" || code === "GOOGLE_SIGNED_OUT") {
        setAttention({ kind: "signin" });
        setView({ kind: "signin" });
      }
      setError(errorMessage(e));
    }
  }, [firstSync, syncNow]);

  useEffect(() => {
    void load();
  }, [load]);

  const doSignIn = async () => {
    setError(null);
    try {
      setProfile(await requestSignIn());
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const review = async (password?: string) => {
    setError(null);
    try {
      const sync = await prepareSync(password);
      if (!("plan" in sync)) return;
      if (sync.plan.pendingDeletions.length === 0) {
        await applySync(sync, []);
        setAttention(null);
        setStatus(await standaloneStatus());
        setCodesKey((k) => k + 1);
        setView({ kind: "codes" });
      } else {
        setView({ kind: "review", sync });
      }
    } catch (e) {
      if (errorCode(e) === "BACKUP_PASSWORD") setView({ kind: "backup-password" });
      else setError(errorMessage(e));
    }
  };

  let body;
  switch (view.kind) {
    case "loading":
      body = error ? (
        <div className="popup__message">
          <button className="auth-btn" onClick={() => void load()}>
            Thử lại
          </button>
        </div>
      ) : (
        <p className="auth-empty">Đang tải từ Google Drive...</p>
      );
      break;
    case "signin":
      body = (
        <div className="popup__message">
          <p className="auth-muted">
            Đăng nhập Google để lấy mã từ bản sao lưu trên Drive mà không cần mở app desktop.
            Thêm tài khoản ở đây cũng được đồng bộ lên Drive.
          </p>
          {googleConfigured() ? (
            <button className="auth-btn auth-btn--primary" onClick={() => void doSignIn()}>
              Đăng nhập Google
            </button>
          ) : (
            <p className="auth-error">
              Bản extension này chưa được cấu hình OAuth Client ID nên chưa đăng nhập Google được
              (xem README).
            </p>
          )}
        </div>
      );
      break;
    case "first-password":
      body = (
        <PasswordForm
          text="Bản sao lưu trên Drive có master password. Nhập master password (giống trên app desktop) để giải mã."
          submit="Mở"
          onSubmit={(password) => firstSync(password)}
        />
      );
      break;
    case "create":
      body = (
        <PasswordForm
          text="Drive chưa có bản sao lưu nào. Nếu đã dùng app desktop, hãy bấm Đồng bộ trong app trước. Hoặc đặt master password để tạo vault mới ngay trong extension."
          submit="Tạo vault"
          confirm
          onSubmit={async (password) => {
            await createVault(password);
            setStatus(await standaloneStatus());
            setView({ kind: "codes" });
          }}
          extra={
            <button className="auth-btn" onClick={() => void load()}>
              Kiểm tra lại Drive
            </button>
          }
        />
      );
      break;
    case "locked":
      body = (
        <PasswordForm
          text="Vault của extension đang khoá. Nhập master password để mở."
          submit="Mở khoá"
          onSubmit={async (password) => {
            await unlock(password);
            await load();
          }}
        />
      );
      break;
    case "backup-password":
      body = (
        <PasswordForm
          text="Master password của bản sao lưu đã được đổi trên app desktop. Nhập master password mới để tiếp tục đồng bộ."
          submit="Tiếp tục"
          onSubmit={(password) => review(password)}
          extra={
            <button className="auth-btn" onClick={() => setView({ kind: "codes" })}>
              Để sau
            </button>
          }
        />
      );
      break;
    case "review":
      body = (
        <Review
          sync={view.sync}
          onDone={async () => {
            setAttention(null);
            setStatus(await standaloneStatus());
            setCodesKey((k) => k + 1);
            setView({ kind: "codes" });
          }}
          onLater={() => setView({ kind: "codes" })}
        />
      );
      break;
    case "codes":
      body = (
        <>
          <SyncBar
            status={status}
            attention={attention}
            syncing={syncing}
            onSync={() => void syncNow()}
            onReview={() => void review()}
            onPassword={() => setView({ kind: "backup-password" })}
            onSignIn={() => void doSignIn()}
          />
          <Codes
            reloadKey={codesKey}
            list={listCodes}
            listGroups={listGroups}
            add={async (uris) => {
              const result = await importUris(uris);
              void syncNow();
              return result;
            }}
            emptyText="Chưa có tài khoản. Quét QR trên trang để thêm, hoặc thêm trong app desktop rồi đồng bộ."
          />
        </>
      );
      break;
  }

  return (
    <>
      {body}
      {error && <p className="auth-error">{error}</p>}
      {profile && (
        <AccountBar
          profile={profile}
          status={status}
          onLock={async () => {
            await lock();
            await load();
          }}
          onSignedOut={() => {
            setProfile(null);
            setStatus(null);
            setAttention(null);
            setView({ kind: "signin" });
          }}
        />
      )}
    </>
  );
}

function PasswordForm({
  text,
  submit,
  confirm = false,
  onSubmit,
  extra,
}: {
  text: string;
  submit: string;
  /** Tạo mật khẩu mới: nhập lại để xác nhận. */
  confirm?: boolean;
  onSubmit: (password: string) => Promise<void>;
  extra?: ReactNode;
}) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (confirm && password !== repeat) {
      setError("Hai mật khẩu không khớp.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (err) {
      setError(errorCode(err) === "WRONG_PASSWORD" ? "Sai master password." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="popup__form" onSubmit={send}>
      <p className="auth-muted">{text}</p>
      <input
        className="auth-input"
        type="password"
        placeholder={confirm ? `Master password (ít nhất ${MIN_PASSWORD_LEN} ký tự)` : "Master password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      {confirm && (
        <input
          className="auth-input"
          type="password"
          placeholder="Nhập lại master password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      )}
      {error && <p className="auth-error">{error}</p>}
      <button className="auth-btn auth-btn--primary" disabled={busy || !password}>
        {busy ? "Đang xử lý..." : submit}
      </button>
      {extra}
    </form>
  );
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}

function SyncBar({
  status,
  attention,
  syncing,
  onSync,
  onReview,
  onPassword,
  onSignIn,
}: {
  status: StandaloneStatus | null;
  attention: Attention | null;
  syncing: boolean;
  onSync: () => void;
  onReview: () => void;
  onPassword: () => void;
  onSignIn: () => void;
}) {
  if (attention) {
    const [text, action, onClick] =
      attention.kind === "review"
        ? [
            `${attention.count} tài khoản đã bị xoá ở máy khác, cần bạn xác nhận.`,
            "Xem",
            onReview,
          ]
        : attention.kind === "password"
          ? ["Master password trên Drive đã đổi.", "Nhập", onPassword]
          : attention.kind === "signin"
            ? ["Phiên Google hết hạn, chưa đồng bộ được.", "Đăng nhập", onSignIn]
            : [`Đồng bộ lỗi: ${attention.message}`, "Thử lại", onSync];
    return (
      <div className="sync-bar sync-bar--attention">
        <span>{text}</span>
        <button className="auth-btn auth-btn--small" onClick={onClick} disabled={syncing}>
          {action}
        </button>
      </div>
    );
  }
  const lastSync = status?.state === "open" ? status.lastSync : null;
  return (
    <div className="sync-bar">
      <span className="auth-muted">
        {syncing
          ? "Đang đồng bộ…"
          : lastSync
            ? `Đã đồng bộ lúc ${formatTime(lastSync)}`
            : "Chưa đồng bộ"}
      </span>
      <button className="auth-btn auth-btn--small" onClick={onSync} disabled={syncing}>
        Đồng bộ
      </button>
    </div>
  );
}

function sideText(p: PendingDeletion): string {
  return p.side === "local"
    ? "Đã bị xoá ở máy khác, extension vẫn còn."
    : "Extension đã xoá, Drive vẫn còn.";
}

/** Xác nhận từng tài khoản sẽ bị xoá; không tích thì tài khoản được giữ ở mọi máy. */
function Review({
  sync,
  onDone,
  onLater,
}: {
  sync: PreparedSync;
  onDone: () => Promise<void>;
  onLater: () => void;
}) {
  const { pendingDeletions, added, uploaded } = sync.plan;
  // Mặc định giữ tài khoản bị xoá ở máy khác (không tích), giống app desktop.
  const [confirmed, setConfirmed] = useState<string[]>(() =>
    pendingDeletions.filter((p) => p.side === "remote").map((p) => p.id),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setConfirmed((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await applySync(sync, confirmed);
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="popup__form">
      <p>
        <strong>Xác nhận xoá</strong>
      </p>
      <p className="auth-muted hint">
        Tích vào tài khoản muốn xoá. Không tích thì tài khoản được giữ lại và có lại ở mọi máy.
        Tài khoản đã xoá vẫn khôi phục được từ Thùng rác trong app desktop.
      </p>
      <ul className="pending-list">
        {pendingDeletions.map((p) => (
          <li key={p.id}>
            <label className="pending-item">
              <input
                type="checkbox"
                checked={confirmed.includes(p.id)}
                onChange={() => toggle(p.id)}
              />
              <span>
                <strong>{p.issuer || p.label}</strong>
                {p.issuer && <span className="auth-muted"> · {p.label}</span>}
                <br />
                <span className="auth-muted hint">
                  {sideText(p)}
                  {p.permanent && " Đã xoá vĩnh viễn ở máy kia, không còn trong Thùng rác."}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {(added.length > 0 || uploaded.length > 0) && (
        <p className="auth-muted hint">
          Đồng thời: thêm {added.length} tài khoản từ Drive, đưa {uploaded.length} tài khoản lên
          Drive.
        </p>
      )}
      {error && <p className="auth-error">{error}</p>}
      <div className="popup__actions">
        <button className="auth-btn" onClick={onLater} disabled={busy}>
          Để sau
        </button>
        <button className="auth-btn auth-btn--primary" onClick={() => void apply()} disabled={busy}>
          {busy ? "Đang đồng bộ..." : `Áp dụng (xoá ${confirmed.length})`}
        </button>
      </div>
    </div>
  );
}

/** Tài khoản Google đang dùng: khoá vault, đăng xuất (cảnh báo nếu còn thay đổi chưa đồng bộ). */
function AccountBar({
  profile,
  status,
  onLock,
  onSignedOut,
}: {
  profile: GoogleProfile;
  status: StandaloneStatus | null;
  onLock: () => Promise<void>;
  onSignedOut: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const unsynced = status !== null && status.state !== "empty" && status.unsynced;

  const doSignOut = async (force: boolean) => {
    setBusy(true);
    try {
      if (!force) {
        // Thử đẩy thay đổi lên Drive trước khi xoá dữ liệu trong extension (vault đang khoá thì
        // không đồng bộ được, chỉ kiểm tra).
        await autoSync().catch(() => null);
        const after = await standaloneStatus();
        if (after.state !== "empty" && after.unsynced) {
          setConfirming(true);
          return;
        }
      }
      await signOut();
      await forget();
      onSignedOut();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="account-bar">
      {confirming ? (
        <>
          <span className="auth-error">
            Có tài khoản thêm trong extension chưa lên được Drive
            {status?.state === "locked" ? " (mở khoá để đồng bộ)" : ""}. Đăng xuất sẽ mất chúng.
          </span>
          <button className="auth-btn auth-btn--small" onClick={() => setConfirming(false)}>
            Huỷ
          </button>
          <button
            className="auth-btn auth-btn--small auth-btn--danger"
            onClick={() => void doSignOut(true)}
            disabled={busy}
          >
            Vẫn đăng xuất
          </button>
        </>
      ) : (
        <>
          <span className="auth-muted account-bar__email" title={profile.email}>
            {profile.email}
            {unsynced && " · chưa đồng bộ"}
          </span>
          {status?.state === "open" && status.hasPassword && (
            <button className="auth-btn auth-btn--small" onClick={() => void onLock()}>
              Khoá
            </button>
          )}
          <button
            className="auth-btn auth-btn--small"
            onClick={() => void doSignOut(false)}
            disabled={busy}
          >
            Đăng xuất
          </button>
        </>
      )}
    </div>
  );
}
