import { useState, type ChangeEvent, type FormEvent } from "react";
import { errorMessage, type Algorithm, type NewAccount } from "@auth/core";
import { decodeQrFromFile } from "@auth/ui";
import { api } from "../api";

type Tab = "uri" | "manual";

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

const EMPTY_ACCOUNT: NewAccount = {
  issuer: "",
  label: "",
  secret: "",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
};

export function AddAccountDialog({ onClose, onAdded }: Props) {
  const [tab, setTab] = useState<Tab>("uri");
  const [uri, setUri] = useState("");
  const [account, setAccount] = useState<NewAccount>(EMPTY_ACCOUNT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = <K extends keyof NewAccount>(key: K, value: NewAccount[K]) =>
    setAccount((a) => ({ ...a, [key]: value }));

  const loadQrImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const text = await decodeQrFromFile(file);
      if (!text) return setError("Không tìm thấy QR code trong ảnh.");
      setUri(text);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await (tab === "uri" ? api.addAccountUri(uri) : api.addAccount(account));
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <form
        className="dialog"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
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
            <textarea
              className="auth-input"
              rows={3}
              placeholder="otpauth://totp/Issuer:user@example.com?secret=..."
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              autoFocus
            />
            <label className="auth-btn file-btn">
              📷 Chọn ảnh QR
              <input type="file" accept="image/*" onChange={loadQrImage} hidden />
            </label>
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
          <button className="auth-btn auth-btn--primary" disabled={busy}>
            {busy ? "Đang lưu..." : "Thêm"}
          </button>
        </div>
      </form>
    </div>
  );
}
