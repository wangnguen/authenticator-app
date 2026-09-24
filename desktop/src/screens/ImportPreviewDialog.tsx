import type { ImportPreview } from "@auth/core";

interface Props {
  preview: ImportPreview;
  /** Ghi chú thêm, ví dụ "1 ảnh không có QR". */
  notes: string[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Popup liệt kê tài khoản đọc được từ ảnh QR, bấm "Thêm" mới lưu. */
export function ImportPreviewDialog({ preview, notes, busy, error, onCancel, onConfirm }: Props) {
  const newCount = preview.accounts.filter((a) => !a.duplicate).length;
  const allNotes = [
    ...(preview.unsupported ? [`${preview.unsupported} tài khoản HOTP chưa hỗ trợ sẽ bị bỏ qua`] : []),
    ...notes,
  ];

  return (
    <div
      className="dialog-backdrop dialog-backdrop--top"
      onMouseDown={(e) => {
        // Không để lan lên nền của hộp thoại "Thêm tài khoản" (sẽ đóng luôn hộp thoại đó).
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Tài khoản đọc được</h2>

        <ul className="preview-list">
          {preview.accounts.map((account, i) => (
            <li
              key={i}
              className={account.duplicate ? "preview-item preview-item--duplicate" : "preview-item"}
            >
              <div className="preview-item__name">
                <strong>{account.issuer || account.label}</strong>
                {account.issuer && <span className="auth-muted">{account.label}</span>}
              </div>
              <div className="preview-item__meta">
                <span className="auth-muted">
                  {account.algorithm} · {account.digits} số · {account.period}s
                </span>
                {account.duplicate && <span className="badge">Đã có</span>}
              </div>
            </li>
          ))}
        </ul>

        {allNotes.map((note) => (
          <p key={note} className="auth-muted hint">
            {note}
          </p>
        ))}
        {error && <p className="auth-error">{error}</p>}

        <div className="dialog__actions">
          <button type="button" className="auth-btn" onClick={onCancel} disabled={busy}>
            Huỷ
          </button>
          <button
            type="button"
            className="auth-btn auth-btn--primary"
            onClick={onConfirm}
            disabled={busy || newCount === 0}
            autoFocus
          >
            {busy
              ? "Đang lưu..."
              : newCount === 0
                ? "Tất cả đã tồn tại"
                : `Thêm ${newCount} tài khoản`}
          </button>
        </div>
      </div>
    </div>
  );
}
