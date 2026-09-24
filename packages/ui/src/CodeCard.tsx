import { useState, type ReactNode } from "react";
import { formatCode, secondsLeft, type CodeEntry } from "@auth/core";
import { CountdownRing } from "./CountdownRing";

interface Props {
  entry: CodeEntry;
  now: number;
  /** Nút phụ bên phải (ví dụ: xoá, điền vào trang). */
  actions?: ReactNode;
}

export function CodeCard({ entry, now, actions }: Props) {
  const [copied, setCopied] = useState(false);
  const remaining = secondsLeft(entry.expiresAt, now);

  const copy = async () => {
    await navigator.clipboard.writeText(entry.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <li className="auth-card">
      <button
        type="button"
        className="auth-card__main"
        onClick={copy}
        title="Bấm để copy"
      >
        <span className="auth-card__issuer">{entry.issuer || entry.label}</span>
        {entry.issuer && <span className="auth-card__label">{entry.label}</span>}
        <span className="auth-card__code">
          {copied ? "Đã copy" : formatCode(entry.code)}
        </span>
      </button>
      <div className="auth-card__side">
        <CountdownRing remaining={remaining} period={entry.period} />
        {actions}
      </div>
    </li>
  );
}
