import { matchesQuery } from "./format";
import type { CodeEntry, Group } from "./types";

export interface GroupFilter {
  /** Group đang chọn trên thanh lọc; null = "Tất cả". */
  selected: string | null;
  /** Hiện cả tài khoản chỉ thuộc group ẩn. */
  showHidden: boolean;
  query: string;
  /** Dịch vụ đang chọn (`ServiceOption.key`); không có = mọi dịch vụ. */
  service?: string | null;
}

/** Tên dịch vụ của tài khoản: chữ in đậm trên thẻ (issuer, không có thì label). */
export function serviceOf(entry: { issuer: string; label: string }): string {
  return entry.issuer.trim() || entry.label.trim();
}

/** Khoá so sánh dịch vụ: không phân biệt hoa thường ("Applovin" = "AppLovin"). */
export function serviceKey(name: string): string {
  return name.trim().toLowerCase();
}

export interface ServiceOption {
  key: string;
  /** Cách viết gặp đầu tiên. */
  name: string;
  count: number;
}

/** Các dịch vụ có trong danh sách, kèm số tài khoản, sắp theo tên. */
export function listServices(entries: { issuer: string; label: string }[]): ServiceOption[] {
  const services = new Map<string, ServiceOption>();
  for (const entry of entries) {
    const name = serviceOf(entry);
    if (!name) continue;
    const key = serviceKey(name);
    const found = services.get(key);
    if (found) found.count++;
    else services.set(key, { key, name, count: 1 });
  }
  return [...services.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "vi", { sensitivity: "base" }),
  );
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
 * - chọn một dịch vụ: chỉ tài khoản của dịch vụ đó.
 * - "Tất cả": bỏ tài khoản bị ẩn, trừ khi bật "hiện group ẩn" hoặc đang tìm kiếm / chọn dịch vụ.
 */
export function filterEntries(entries: CodeEntry[], groups: Group[], filter: GroupFilter): CodeEntry[] {
  const searching = filter.query.trim() !== "" || !!filter.service;
  return entries.filter((entry) => {
    if (!matchesQuery(entry, filter.query)) return false;
    if (filter.service && serviceKey(serviceOf(entry)) !== filter.service) return false;
    if (filter.selected) return entry.groupIds?.includes(filter.selected) ?? false;
    return searching || filter.showHidden || !isHiddenEntry(entry, groups);
  });
}
