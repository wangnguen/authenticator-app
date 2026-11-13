import type { AccountSummary, PendingDeletion } from "@auth/core";
import { compareId } from "./backup";
import {
  type Account,
  changedAt,
  type Deleted,
  groupChangedAt,
  type StoredGroup,
  type VaultData,
} from "./types";

/**
 * Gộp vault của extension với bản sao lưu trên Drive. Chép nguyên quy tắc của
 * desktop/src-tauri/src/sync.rs để mọi máy gộp ra cùng một kết quả:
 * - chỉ một bên có → giữ; cả hai có → lấy bản thay đổi sau cùng.
 * - một bên còn, bên kia đã xoá sau lần thay đổi cuối → chờ người dùng xác nhận, không tự xoá.
 * - tài khoản trùng secret được gộp làm một, giữ bản có id nhỏ nhất (cộng group của các bản).
 * - group: lấy bản thay đổi sau cùng; bằng nhau thì bản đã xoá thắng.
 */

interface Pending {
  account: Account;
  deleted: Deleted;
  side: "local" | "remote";
}

export interface SyncSummary {
  added: number;
  uploaded: number;
  deleted: number;
  kept: number;
}

export interface Merge {
  accounts: Account[];
  deleted: Deleted[];
  groups: StoredGroup[];
  pending: Pending[];
  /** Tài khoản lấy từ bản sao lưu, extension chưa có. */
  added: AccountSummary[];
  /** Tài khoản chỉ extension có, sẽ được đưa lên bản sao lưu. */
  uploaded: AccountSummary[];
}

const summary = (a: Account): AccountSummary => ({ id: a.id, issuer: a.issuer, label: a.label });

export function computeMerge(local: VaultData, remote: VaultData): Merge {
  const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((i) => [i.id, i]));
  const localAccounts = byId(local.accounts);
  const remoteAccounts = byId(remote.accounts);
  const localDeleted = byId(local.deleted);
  const remoteDeleted = byId(remote.deleted);
  const ids = [
    ...new Set([
      ...localAccounts.keys(),
      ...remoteAccounts.keys(),
      ...localDeleted.keys(),
      ...remoteDeleted.keys(),
    ]),
  ].sort(compareId);

  const accounts: Account[] = [];
  const deleted: Deleted[] = [];
  const pending: Pending[] = [];
  for (const id of ids) {
    const here = localAccounts.get(id);
    const there = remoteAccounts.get(id);
    const alive =
      here && there ? (changedAt(there) > changedAt(here) ? there : here) : (here ?? there);
    const tomb = mergeDeleted(localDeleted.get(id), remoteDeleted.get(id));
    if (alive && tomb && tomb.deletedAt >= changedAt(alive)) {
      // Bị xoá sau lần thay đổi cuối: không tự xoá, chờ người dùng xác nhận.
      pending.push({ account: { ...alive }, deleted: tomb, side: here ? "local" : "remote" });
    } else if (alive) {
      accounts.push({ ...alive });
    } else if (tomb) {
      deleted.push(tomb);
    }
  }
  dedup(accounts);
  return {
    accounts,
    deleted,
    groups: mergeGroups(local.groups, remote.groups),
    pending,
    added: newIn(accounts, local.accounts),
    uploaded: newIn(accounts, remote.accounts),
  };
}

export function pendingDeletions(merge: Merge): PendingDeletion[] {
  return merge.pending.map((p) => ({
    id: p.account.id,
    issuer: p.account.issuer,
    label: p.account.label,
    side: p.side,
    deletedAt: p.deleted.deletedAt,
    permanent: !p.deleted.account,
  }));
}

/**
 * Kết quả gộp. Chỉ xoá tài khoản có id trong `confirmed`; còn lại được giữ và đánh dấu thay đổi
 * lúc `now` để thắng bản ghi xoá ở mọi máy.
 */
export function resolveMerge(
  merge: Merge,
  confirmed: string[],
  now: number,
): { data: VaultData; summary: SyncSummary } {
  const result: SyncSummary = {
    added: merge.added.length,
    uploaded: merge.uploaded.length,
    deleted: 0,
    kept: 0,
  };
  const accounts = merge.accounts.map((a) => ({ ...a }));
  const deleted = [...merge.deleted];
  for (const { account, deleted: tomb } of merge.pending) {
    if (confirmed.includes(account.id)) {
      // Giữ bản mới nhất trong Thùng rác (trừ khi bên kia đã xoá vĩnh viễn).
      deleted.push(tomb.account ? { ...tomb, account } : tomb);
      result.deleted++;
    } else {
      accounts.push({ ...account, updatedAt: now });
      result.kept++;
    }
  }
  dedup(accounts);
  deleted.sort((a, b) => compareId(a.id, b.id));
  return { data: { accounts, deleted, groups: merge.groups.map((g) => ({ ...g })) }, summary: result };
}

function mergeDeleted(a?: Deleted, b?: Deleted): Deleted | undefined {
  if (!a || !b) return a ?? b;
  const newer = b.deletedAt > a.deletedAt ? b : a;
  // Xoá vĩnh viễn ở một máy thì xoá vĩnh viễn ở mọi máy.
  const purged = !a.account || !b.account;
  return purged
    ? { id: newer.id, deletedAt: newer.deletedAt }
    : { id: newer.id, deletedAt: newer.deletedAt, account: newer.account };
}

/** Gộp tài khoản trùng secret, giữ bản có id nhỏ nhất (cộng group của các bản bị bỏ). */
function dedup(accounts: Account[]) {
  accounts.sort((a, b) => compareId(a.id, b.id));
  const kept = new Map<string, Account>();
  let write = 0;
  for (const account of accounts) {
    const first = kept.get(account.secret);
    if (first) {
      const ids = [...new Set([...(first.groupIds ?? []), ...(account.groupIds ?? [])])].sort(compareId);
      first.groupIds = ids;
      continue;
    }
    kept.set(account.secret, account);
    accounts[write++] = account;
  }
  accounts.length = write;
}

function mergeGroups(local: StoredGroup[], remote: StoredGroup[]): StoredGroup[] {
  const merged = new Map<string, StoredGroup>();
  const rank = (g: StoredGroup): [number, number] => [groupChangedAt(g), g.deletedAt !== undefined ? 1 : 0];
  for (const group of [...local, ...remote]) {
    const current = merged.get(group.id);
    if (current) {
      const [a, b] = [rank(group), rank(current)];
      if (!(a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]))) continue;
    }
    merged.set(group.id, group);
  }
  return [...merged.values()].sort((a, b) => compareId(a.id, b.id));
}

/** Tài khoản trong `merged` mà `base` chưa có (khác id và khác secret). */
function newIn(merged: Account[], base: Account[]): AccountSummary[] {
  const ids = new Set(base.map((a) => a.id));
  const secrets = new Set(base.map((a) => a.secret));
  return merged.filter((a) => !ids.has(a.id) && !secrets.has(a.secret)).map(summary);
}
