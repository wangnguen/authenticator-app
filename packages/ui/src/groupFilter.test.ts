import { type CodeEntry, filterEntries, type Group, isHiddenEntry, listServices } from "@auth/core";
import { describe, expect, it } from "vitest";

const entry = (id: string, groupIds?: string[]): CodeEntry => ({
  id,
  issuer: id,
  label: "",
  code: "123456",
  digits: 6,
  period: 30,
  expiresAt: 0,
  groupIds,
});

const work: Group = { id: "work", name: "Công việc", hidden: false, count: 2 };
const secret: Group = { id: "secret", name: "Bí mật", hidden: true, count: 2 };
const groups = [work, secret];
const entries = [
  entry("none"),
  entry("work-only", ["work"]),
  entry("secret-only", ["secret"]),
  entry("both", ["work", "secret"]),
];
const ids = (list: CodeEntry[]) => list.map((e) => e.id);

describe("lọc theo group", () => {
  it("tài khoản chỉ thuộc group ẩn thì bị ẩn, thuộc thêm group đang hiện thì vẫn hiện", () => {
    expect(isHiddenEntry(entries[2], groups)).toBe(true);
    expect(isHiddenEntry(entries[3], groups)).toBe(false);
    expect(isHiddenEntry(entries[0], groups)).toBe(false);
  });

  it("Tất cả: bỏ tài khoản bị ẩn, trừ khi bật hiện group ẩn hoặc đang tìm kiếm", () => {
    const filter = { selected: null, showHidden: false, query: "" };
    expect(ids(filterEntries(entries, groups, filter))).toEqual(["none", "work-only", "both"]);
    expect(filterEntries(entries, groups, { ...filter, showHidden: true })).toHaveLength(4);
    expect(ids(filterEntries(entries, groups, { ...filter, query: "secret" }))).toEqual(["secret-only"]);
  });

  it("chọn group: chỉ tài khoản của group đó (một tài khoản ở nhiều group)", () => {
    const filter = { selected: "work", showHidden: false, query: "" };
    expect(ids(filterEntries(entries, groups, filter))).toEqual(["work-only", "both"]);
    expect(ids(filterEntries(entries, groups, { ...filter, selected: "secret" }))).toEqual([
      "secret-only",
      "both",
    ]);
  });

  it("group đã xoá (không còn trong danh sách) không làm ẩn tài khoản", () => {
    expect(isHiddenEntry(entry("x", ["deleted-group"]), groups)).toBe(false);
  });
});

describe("lọc theo dịch vụ", () => {
  const svc = (id: string, issuer: string, label = "", groupIds?: string[]): CodeEntry => ({
    ...entry(id, groupIds),
    issuer,
    label,
  });
  const list = [
    svc("a1", "Applovin", "x"),
    svc("a2", "AppLovin ", "y", ["secret"]),
    svc("o1", "OpenVPN", "z", ["work"]),
    svc("l1", "", "me@example.com"),
  ];

  it("gom theo tên in đậm, không phân biệt hoa thường; không có issuer thì lấy label", () => {
    expect(listServices(list)).toEqual([
      { key: "applovin", name: "Applovin", count: 2 },
      { key: "me@example.com", name: "me@example.com", count: 1 },
      { key: "openvpn", name: "OpenVPN", count: 1 },
    ]);
  });

  it("chọn dịch vụ: chỉ tài khoản của dịch vụ đó (kể cả trong group ẩn), kết hợp với group và tìm kiếm", () => {
    const filter = { selected: null, showHidden: false, query: "", service: "applovin" };
    expect(ids(filterEntries(list, groups, filter))).toEqual(["a1", "a2"]);
    expect(ids(filterEntries(list, groups, { ...filter, query: "y" }))).toEqual(["a2"]);
    expect(ids(filterEntries(list, groups, { ...filter, selected: "secret" }))).toEqual(["a2"]);
    expect(filterEntries(list, groups, { ...filter, selected: "work" })).toHaveLength(0);
  });
});
