import { matchesQuery } from "./format";
import type { CodeEntry, Group } from "./types";

export interface GroupFilter {
  /** Group đang chọn trên thanh lọc; null = "Tất cả". */
  selected: string | null;
  /** Hiện cả tài khoản chỉ thuộc group ẩn. */
  showHidden: boolean;
  query: string;
}

/**
 * Tài khoản bị ẩn: có group, và mọi group của nó đều đang ẩn. Tài khoản còn thuộc ít nhất một
 * group đang hiện (hoặc chưa thuộc group nào) thì vẫn hiện.
 */
export function isHiddenEntry(entry: CodeEntry, groups: Group[]): boolean {
  const own = groups.filter((g) => entry.groupIds?.includes(g.id));
  return own.length > 0 && own.every((g) => g.hidden);
}

/**
 * Danh sách hiển thị:
 * - chọn một group: chỉ tài khoản của group đó.
 * - "Tất cả": bỏ tài khoản bị ẩn, trừ khi bật "hiện group ẩn" hoặc đang tìm kiếm.
 */
export function filterEntries(entries: CodeEntry[], groups: Group[], filter: GroupFilter): CodeEntry[] {
  const searching = filter.query.trim() !== "";
  return entries.filter((entry) => {
    if (!matchesQuery(entry, filter.query)) return false;
    if (filter.selected) return entry.groupIds?.includes(filter.selected) ?? false;
    return searching || filter.showHidden || !isHiddenEntry(entry, groups);
  });
}
