import type { ReactNode } from "react";
import { matchesQuery, type CodeEntry } from "@auth/core";
import { CodeCard } from "./CodeCard";

interface Props {
  entries: CodeEntry[];
  now: number;
  query?: string;
  emptyText?: string;
  renderActions?: (entry: CodeEntry) => ReactNode;
}

export function CodeList({
  entries,
  now,
  query = "",
  emptyText = "Chưa có tài khoản nào.",
  renderActions,
}: Props) {
  const visible = entries.filter((e) => matchesQuery(e, query));

  if (visible.length === 0) {
    return (
      <p className="auth-empty">{query ? "Không tìm thấy." : emptyText}</p>
    );
  }

  return (
    <ul className="auth-list">
      {visible.map((entry) => (
        <CodeCard
          key={entry.id}
          entry={entry}
          now={now}
          actions={renderActions?.(entry)}
        />
      ))}
    </ul>
  );
}
