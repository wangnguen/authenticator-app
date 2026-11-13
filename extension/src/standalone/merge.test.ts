import { describe, expect, it } from "vitest";
import { computeMerge, pendingDeletions, resolveMerge } from "./merge";
import { type Account, changedAt, type Deleted, type VaultData } from "./types";

// Cùng các tình huống với test trong desktop/src-tauri/src/sync.rs.

function account(id: string, secret: string, at: number): Account {
  return {
    id,
    issuer: `Issuer ${id}`,
    label: "me@example.com",
    secret,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    createdAt: at,
    updatedAt: at,
  };
}

const tomb = (a: Account, at: number): Deleted => ({ id: a.id, deletedAt: at, account: a });
const data = (accounts: Account[], deleted: Deleted[] = []): VaultData => ({ accounts, deleted });
const ids = (d: VaultData) => d.accounts.map((a) => a.id);

describe("gộp với bản sao lưu", () => {
  it("gộp tài khoản thêm ở cả hai bên", () => {
    const local = data([account("a", "AAAA", 1), account("b", "BBBB", 1)]);
    const remote = data([account("b", "BBBB", 1), account("c", "CCCC", 2)]);
    const merge = computeMerge(local, remote);
    expect(pendingDeletions(merge)).toEqual([]);
    expect(merge.added.map((a) => a.id)).toEqual(["c"]);
    expect(merge.uploaded.map((a) => a.id)).toEqual(["a"]);
    const { data: result, summary } = resolveMerge(merge, [], 10);
    expect(ids(result)).toEqual(["a", "b", "c"]);
    expect([summary.added, summary.uploaded]).toEqual([1, 1]);
  });

  it("tài khoản bị xoá ở máy khác phải chờ xác nhận", () => {
    const local = data([account("a", "AAAA", 1), account("b", "BBBB", 1)]);
    const remote = data([account("a", "AAAA", 1)], [tomb(account("b", "BBBB", 1), 5)]);
    const pending = pendingDeletions(computeMerge(local, remote));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: "b", side: "local", permanent: false });

    // Không xác nhận: giữ lại, thắng bản ghi xoá.
    const kept = resolveMerge(computeMerge(local, remote), [], 10);
    expect(ids(kept.data)).toEqual(["a", "b"]);
    expect(kept.data.deleted).toEqual([]);
    expect(changedAt(kept.data.accounts[1])).toBe(10);
    expect(kept.summary.kept).toBe(1);

    // Xác nhận: chuyển vào Thùng rác, vẫn còn dữ liệu.
    const removed = resolveMerge(computeMerge(local, remote), ["b"], 10);
    expect(ids(removed.data)).toEqual(["a"]);
    expect(removed.data.deleted[0].account?.secret).toBe("BBBB");
    expect(removed.summary.deleted).toBe(1);
  });

  it("xoá ở máy này cũng chờ xác nhận", () => {
    const local = data([], [tomb(account("a", "AAAA", 1), 5)]);
    const remote = data([account("a", "AAAA", 1)]);
    const merge = computeMerge(local, remote);
    expect(pendingDeletions(merge)[0].side).toBe("remote");
    const { data: result } = resolveMerge(merge, ["a"], 10);
    expect(result.accounts).toEqual([]);
    expect(result.deleted).toHaveLength(1);
    expect(pendingDeletions(computeMerge(result, result))).toEqual([]);
  });

  it("khôi phục sau khi xoá thì thắng", () => {
    const local = data([account("a", "AAAA", 8)]);
    const remote = data([], [tomb(account("a", "AAAA", 1), 5)]);
    const merge = computeMerge(local, remote);
    expect(pendingDeletions(merge)).toEqual([]);
    const { data: result } = resolveMerge(merge, [], 10);
    expect(ids(result)).toEqual(["a"]);
    expect(result.deleted).toEqual([]);
  });

  it("cùng secret thêm ở hai máy được gộp làm một", () => {
    const merge = computeMerge(data([account("b", "SAME", 1)]), data([account("a", "SAME", 2)]));
    expect(merge.added).toEqual([]);
    expect(merge.uploaded).toEqual([]);
    expect(ids(resolveMerge(merge, [], 10).data)).toEqual(["a"]);
  });

  it("xoá vĩnh viễn thắng", () => {
    const purged: Deleted = { id: "a", deletedAt: 6 };
    const local = data([], [tomb(account("a", "AAAA", 1), 5)]);
    const { data: result } = resolveMerge(computeMerge(local, data([], [purged])), [], 10);
    expect(result.deleted[0].account).toBeUndefined();
  });

  it("vault cũ không có updatedAt dùng createdAt", () => {
    const old = { ...account("a", "AAAA", 7), updatedAt: undefined };
    expect(changedAt(old)).toBe(7);
  });
});
