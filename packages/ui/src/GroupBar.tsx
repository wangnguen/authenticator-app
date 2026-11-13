import type { ReactNode } from "react";
import type { Group } from "@auth/core";
import { Icon } from "./Icon";

interface Props {
  groups: Group[];
  /** Group đang chọn; null = "Tất cả". */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Đang hiện cả group ẩn. */
  showHidden: boolean;
  onToggleHidden: () => void;
  /** Nút thêm ở cuối hàng (ví dụ: tạo / quản lý group trong app desktop). */
  actions?: ReactNode;
}

/** Hàng chip lọc theo group: "Tất cả", từng group, nút hiện/ẩn group ẩn. */
export function GroupBar({ groups, selected, onSelect, showHidden, onToggleHidden, actions }: Props) {
  const hiddenCount = groups.filter((g) => g.hidden).length;
  const visible = groups.filter((g) => showHidden || !g.hidden);
  if (groups.length === 0 && !actions) return null;

  return (
    <div className="auth-groups" role="tablist" aria-label="Lọc theo group">
      <button
        role="tab"
        aria-selected={selected === null}
        className={selected === null ? "auth-chip auth-chip--active" : "auth-chip"}
        onClick={() => onSelect(null)}
      >
        Tất cả
      </button>
      {visible.map((group) => (
        <button
          key={group.id}
          role="tab"
          aria-selected={selected === group.id}
          className={[
            "auth-chip",
            selected === group.id && "auth-chip--active",
            group.hidden && "auth-chip--hidden",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => onSelect(selected === group.id ? null : group.id)}
          title={group.hidden ? `${group.name} (đang ẩn)` : group.name}
        >
          {group.name}
          <span className="auth-chip__count">{group.count}</span>
        </button>
      ))}
      {hiddenCount > 0 && (
        <button
          className="auth-chip auth-chip--ghost"
          onClick={onToggleHidden}
          title={showHidden ? "Không hiện group ẩn" : "Hiện cả group ẩn"}
          aria-pressed={showHidden}
        >
          <Icon name={showHidden ? "eye-off" : "eye"} />
          {showHidden ? "Giấu" : `${hiddenCount} ẩn`}
        </button>
      )}
      {actions}
    </div>
  );
}
