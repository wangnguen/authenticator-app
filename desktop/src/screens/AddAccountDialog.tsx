import {
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import {
  describeImport,
  errorMessage,
  type Algorithm,
  type ImportPreview,
  type NewAccount,
} from "@auth/core";
import { scanOtpQrImages, type QrScanResult } from "@auth/ui";
import { api } from "../api";
import { ImportPreviewDialog } from "./ImportPreviewDialog";

type Tab = "uri" | "manual";

interface Props {
  onClose: () => void;
  onAdded: (message: string) => void;
}

/** Kết quả đọc ảnh dán vào, chờ người dùng bấm "Thêm" trong popup xem trước. */
interface PendingImport {
  uris: string;
  preview: ImportPreview;
  notes: string[];
}

const EMPTY_ACCOUNT: NewAccount = {
  issuer: "",
  label: "",
  secret: "",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
};

function scanNotes(scan: QrScanResult): string[] {
  const notes: string[] = [];
  if (scan.imagesWithoutQr) notes.push(`${scan.imagesWithoutQr} ảnh không có QR`);
  if (scan.otherQr) notes.push(`${scan.otherQr} QR không phải mã 2FA`);
  return notes;
}

/** " (1 ảnh không có QR, 2 QR không phải mã 2FA)" */
function scanNote(scan: QrScanResult): string {
  const notes = scanNotes(scan);
  return notes.length ? ` (${notes.join(", ")})` : "";
}

function noQrMessage(scan: QrScanResult): string {
  return scan.otherQr
    ? "QR trong ảnh không phải mã 2FA (otpauth://)."
    : "Không tìm thấy QR code trong ảnh.";
}

function imageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((f) => f.type.startsWith("image/"));
}

export function AddAccountDialog({ onClose, onAdded }: Props) {
  const [tab, setTab] = useState<Tab>("uri");
  const [uri, setUri] = useState("");
  const [account, setAccount] = useState<NewAccount>(EMPTY_ACCOUNT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const update = <K extends keyof NewAccount>(key: K, value: NewAccount[K]) =>
    setAccount((a) => ({ ...a, [key]: value }));

  /** Chọn file / kéo thả: quét QR rồi import luôn, không cần bấm "Thêm". */
  const importImages = async (files: File[]) => {
    const images = imageFiles(files);
    if (images.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const scan = await scanOtpQrImages(images);
      if (scan.uris.length === 0) {
        setError(noQrMessage(scan));
        return;
      }
      const result = await api.importUri(scan.uris.join("\n"));
      onAdded(describeImport(result) + scanNote(scan));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const pickImages = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void importImages(files);
  };

  const dropImages = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void importImages(Array.from(e.dataTransfer.files));
  };

  /**
   * Ctrl+V ảnh vào ô nhập: hiện loading trong lúc đọc QR, xong thì mở popup liệt kê
   * tài khoản đọc được để bấm "Thêm". Dán chữ vẫn bình thường.
   */
  const pasteIntoInput = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    if (reading || busy) return;
    setReading(true);
    setError(null);
    try {
      const scan = await scanOtpQrImages(files);
      if (scan.uris.length === 0) {
        setError(noQrMessage(scan));
        return;
      }
      const uris = scan.uris.join("\n");
      setPendingError(null);
      setPending({ uris, preview: await api.previewUri(uris), notes: scanNotes(scan) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReading(false);
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    setBusy(true);
    setPendingError(null);
    try {
      const result = await api.importUri(pending.uris);
      const note = pending.notes.length ? ` (${pending.notes.join(", ")})` : "";
      onAdded(describeImport(result) + note);
    } catch (err) {
      setPendingError(errorMessage(err));
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (tab === "uri") {
        onAdded(describeImport(await api.importUri(uri)));
      } else {
        const added = await api.addAccount(account);
        onAdded(describeImport({ added: [added], duplicates: 0, unsupported: 0 }));
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <form
        className={dragging ? "dialog dialog--dragging" : "dialog"}
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={dropImages}
      >
        <h2>Thêm tài khoản</h2>

        <div className="tabs">
          <button
            type="button"
            className={tab === "uri" ? "tab tab--active" : "tab"}
            onClick={() => setTab("uri")}
          >
            Link / QR
          </button>
          <button
            type="button"
            className={tab === "manual" ? "tab tab--active" : "tab"}
            onClick={() => setTab("manual")}
          >
            Nhập tay
          </button>
        </div>

        {tab === "uri" ? (
          <>
            <div className="paste-box">
              <textarea
                className="auth-input"
                rows={3}
                placeholder={
                  "Dán link hoặc Ctrl+V ảnh QR vào đây\n" +
                  "otpauth://... hoặc otpauth-migration://... (Google Authenticator)\n" +
                  "Nhiều link: mỗi dòng một link"
                }
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                onPaste={(e) => void pasteIntoInput(e)}
                readOnly={reading}
                autoFocus
              />
              {reading && (
                <div className="paste-box__loading">
                  <span className="spinner" />
                  Đang đọc QR trong ảnh…
                </div>
              )}
            </div>
            <label className={busy ? "auth-btn file-btn file-btn--busy" : "auth-btn file-btn"}>
              {busy ? "Đang đọc QR..." : "📷 Chọn ảnh QR (chọn được nhiều ảnh)"}
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={pickImages}
                disabled={busy}
                hidden
              />
            </label>
            <p className="auth-muted hint">
              Chọn ảnh hoặc kéo thả ảnh vào đây thì tài khoản được thêm ngay. Mỗi ảnh có thể chứa
              nhiều QR.
            </p>
          </>
        ) : (
          <>
            <input
              className="auth-input"
              placeholder="Dịch vụ (vd: GitHub)"
              value={account.issuer}
              onChange={(e) => update("issuer", e.target.value)}
              autoFocus
            />
            <input
              className="auth-input"
              placeholder="Tài khoản (vd: me@example.com)"
              value={account.label}
              onChange={(e) => update("label", e.target.value)}
            />
            <input
              className="auth-input mono"
              placeholder="Secret key (Base32)"
              value={account.secret}
              onChange={(e) => update("secret", e.target.value)}
            />
            <div className="row">
              <select
                className="auth-input"
                value={account.algorithm}
                onChange={(e) => update("algorithm", e.target.value as Algorithm)}
              >
                <option value="SHA1">SHA1</option>
                <option value="SHA256">SHA256</option>
                <option value="SHA512">SHA512</option>
              </select>
              <select
                className="auth-input"
                value={account.digits}
                onChange={(e) => update("digits", Number(e.target.value))}
              >
                <option value={6}>6 số</option>
                <option value={7}>7 số</option>
                <option value={8}>8 số</option>
              </select>
              <input
                className="auth-input"
                type="number"
                min={1}
                max={300}
                value={account.period}
                onChange={(e) => update("period", Number(e.target.value))}
                title="Chu kỳ (giây)"
              />
            </div>
          </>
        )}

        {error && <p className="auth-error">{error}</p>}

        <div className="dialog__actions">
          <button type="button" className="auth-btn" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="auth-btn auth-btn--primary"
            disabled={busy || reading || (tab === "uri" && !uri.trim())}
          >
            {busy ? "Đang lưu..." : "Thêm"}
          </button>
        </div>
      </form>

      {pending && (
        <ImportPreviewDialog
          preview={pending.preview}
          notes={pending.notes}
          busy={busy}
          error={pendingError}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        />
      )}
    </div>
  );
}
