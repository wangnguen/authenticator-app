import { type ComponentProps, useState, type ReactNode } from "react";
import { formatCode, secondsLeft, type CodeEntry } from "@auth/core";
import { CountdownRing } from "./CountdownRing";

interface Props {
  entry: CodeEntry;
  now: number;
  /** Nút phụ bên phải (ví dụ: xoá, điền vào trang). */
  actions?: ReactNode;
  /** Tên các group của tài khoản, hiện thành nhãn nhỏ. */
  tags?: string[];
  /** Thuộc tính thêm cho thẻ `<li>` (kéo thả trong `CodeList`). */
  itemProps?: ComponentProps<"li">;
  /** Thẻ kéo được để đổi vị trí (chỉ để ghi gợi ý). */
  draggable?: boolean;
}

export function CodeCard({ entry, now, actions, tags, itemProps, draggable }: Props) {
  const [copied, setCopied] = useState(false);
  const remaining = secondsLeft(entry.expiresAt, now);

  const copy = async () => {
    await navigator.clipboard.writeText(entry.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <li {...itemProps} className={["auth-card", itemProps?.className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="auth-card__main"
        onClick={copy}
        title={draggable ? "Bấm để copy, giữ và kéo để đổi vị trí" : "Bấm để copy"}
      >
        <span className="auth-card__issuer">{entry.issuer || entry.label}</span>
        {entry.issuer && <span className="auth-card__label">{entry.label}</span>}
        {tags && tags.length > 0 && (
          <span className="auth-card__tags">
            {tags.map((tag) => (
              <span key={tag} className="auth-tag">
                {tag}
              </span>
            ))}
          </span>
        )}
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
