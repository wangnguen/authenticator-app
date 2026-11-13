//! Đồng bộ 2 chiều giữa vault trên máy và bản sao lưu trên Google Drive.
//!
//! Mỗi tài khoản có `id` cố định. Xoá tài khoản để lại bản ghi [`Deleted`] (id + thời điểm xoá,
//! kèm dữ liệu để khôi phục từ Thùng rác), nhờ đó máy khác phân biệt được "đã xoá" với "chưa có".
//!
//! Gộp theo từng `id`:
//! - chỉ một bên có → giữ (tài khoản mới thêm).
//! - cả hai bên cùng có → lấy bản thay đổi sau cùng.
//! - một bên còn, bên kia đã xoá sau lần thay đổi cuối → **chờ người dùng xác nhận**, không tự xoá.
//!   Không xác nhận thì tài khoản được giữ lại (và sẽ có lại ở mọi máy).
//! - cả hai bên đều đã xoá → giữ bản ghi xoá.
//!
//! Cuối cùng các tài khoản trùng secret (cùng một tài khoản thêm riêng trên hai máy) được gộp làm
//! một, giữ bản có `id` nhỏ nhất để mọi máy chọn giống nhau (group của hai bản được gộp lại).
//!
//! Group gộp theo `id`, lấy bản thay đổi sau cùng (đổi tên, ẩn/hiện, xoá). Xoá group không cần
//! xác nhận vì không làm mất tài khoản nào.

use crate::vault::{Account, AccountSummary, Deleted, Group, VaultData};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Bên sẽ mất tài khoản nếu đồng ý xoá.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    /// Tài khoản đang có trên máy này, đã bị xoá ở máy khác.
    Local,
    /// Tài khoản còn trong bản sao lưu, đã bị xoá trên máy này.
    Remote,
}

/// Tài khoản cần người dùng xác nhận trước khi xoá (không chứa secret).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeletion {
    pub id: String,
    pub issuer: String,
    pub label: String,
    pub side: Side,
    /// Unix ms.
    pub deleted_at: u64,
    /// Bên kia đã xoá vĩnh viễn: đồng ý xoá thì tài khoản không còn trong Thùng rác.
    pub permanent: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    /// Số tài khoản lấy từ bản sao lưu về máy này.
    pub added: usize,
    /// Số tài khoản từ máy này đưa lên bản sao lưu.
    pub uploaded: usize,
    /// Số tài khoản đã đồng ý xoá.
    pub deleted: usize,
    /// Số tài khoản được giữ lại dù một bên đã xoá.
    pub kept: usize,
}

struct Pending {
    account: Account,
    deleted: Deleted,
    side: Side,
}

pub struct Merge {
    accounts: Vec<Account>,
    deleted: Vec<Deleted>,
    groups: Vec<Group>,
    pending: Vec<Pending>,
    /// Tài khoản lấy từ bản sao lưu, chưa có trên máy này.
    pub added: Vec<AccountSummary>,
    /// Tài khoản chỉ có trên máy này, sẽ được đưa lên bản sao lưu.
    pub uploaded: Vec<AccountSummary>,
}

impl Merge {
    pub fn compute(local: &VaultData, remote: &VaultData) -> Self {
        let local_accounts: HashMap<&str, &Account> =
            local.accounts.iter().map(|a| (a.id.as_str(), a)).collect();
        let remote_accounts: HashMap<&str, &Account> =
            remote.accounts.iter().map(|a| (a.id.as_str(), a)).collect();
        let local_deleted: HashMap<&str, &Deleted> =
            local.deleted.iter().map(|d| (d.id.as_str(), d)).collect();
        let remote_deleted: HashMap<&str, &Deleted> =
            remote.deleted.iter().map(|d| (d.id.as_str(), d)).collect();
        let ids: BTreeSet<&str> = local_accounts
            .keys()
            .chain(remote_accounts.keys())
            .chain(local_deleted.keys())
            .chain(remote_deleted.keys())
            .copied()
            .collect();

        let mut accounts = Vec::new();
        let mut deleted = Vec::new();
        let mut pending = Vec::new();
        for id in ids {
            let here = local_accounts.get(id).copied();
            let there = remote_accounts.get(id).copied();
            let alive = match (here, there) {
                (Some(a), Some(b)) => Some(if b.changed_at() > a.changed_at() { b } else { a }),
                (a, b) => a.or(b),
            };
            let tomb = merge_deleted(local_deleted.get(id).copied(), remote_deleted.get(id).copied());
            match (alive, tomb) {
                // Bị xoá sau lần thay đổi cuối: không tự xoá, chờ người dùng xác nhận.
                (Some(account), Some(tomb)) if tomb.deleted_at >= account.changed_at() => {
                    pending.push(Pending {
                        account: account.clone(),
                        deleted: tomb,
                        side: if here.is_some() { Side::Local } else { Side::Remote },
                    })
                }
                // Được khôi phục sau khi xoá (hoặc chưa từng bị xoá): giữ, bỏ bản ghi xoá.
                (Some(account), _) => accounts.push(account.clone()),
                (None, Some(tomb)) => deleted.push(tomb),
                (None, None) => {}
            }
        }
        dedup(&mut accounts);

        let added = new_in(&accounts, &local.accounts);
        let uploaded = new_in(&accounts, &remote.accounts);
        Self {
            accounts,
            deleted,
            groups: merge_groups(&local.groups, &remote.groups),
            pending,
            added,
            uploaded,
        }
    }

    pub fn pending(&self) -> Vec<PendingDeletion> {
        self.pending
            .iter()
            .map(|p| PendingDeletion {
                id: p.account.id.clone(),
                issuer: p.account.issuer.clone(),
                label: p.account.label.clone(),
                side: p.side,
                deleted_at: p.deleted.deleted_at,
                permanent: p.deleted.account.is_none(),
            })
            .collect()
    }

    /// Kết quả gộp. Chỉ xoá các tài khoản có id trong `confirmed`; còn lại được giữ và đánh dấu
    /// thay đổi lúc `now` để thắng bản ghi xoá ở mọi máy.
    pub fn resolve(self, confirmed: &[String], now: u64) -> (VaultData, SyncSummary) {
        let mut summary = SyncSummary {
            added: self.added.len(),
            uploaded: self.uploaded.len(),
            ..SyncSummary::default()
        };
        let (mut accounts, mut deleted, groups) = (self.accounts, self.deleted, self.groups);
        for Pending {
            mut account,
            deleted: mut tomb,
            ..
        } in self.pending
        {
            if confirmed.contains(&account.id) {
                // Giữ bản mới nhất trong Thùng rác (trừ khi bên kia đã xoá vĩnh viễn).
                if tomb.account.is_some() {
                    tomb.account = Some(account);
                }
                deleted.push(tomb);
                summary.deleted += 1;
            } else {
                account.updated_at = now;
                accounts.push(account);
                summary.kept += 1;
            }
        }
        dedup(&mut accounts);
        deleted.sort_by(|a, b| a.id.cmp(&b.id));
        (
            VaultData {
                accounts,
                deleted,
                groups,
            },
            summary,
        )
    }
}

fn merge_deleted(a: Option<&Deleted>, b: Option<&Deleted>) -> Option<Deleted> {
    match (a, b) {
        (Some(a), Some(b)) => {
            let newer = if b.deleted_at > a.deleted_at { b } else { a };
            Some(Deleted {
                id: newer.id.clone(),
                deleted_at: newer.deleted_at,
                // Xoá vĩnh viễn ở một máy thì xoá vĩnh viễn ở mọi máy.
                account: if a.account.is_none() || b.account.is_none() {
                    None
                } else {
                    newer.account.clone()
                },
            })
        }
        (a, b) => a.or(b).cloned(),
    }
}

/// Gộp tài khoản trùng secret, giữ bản có id nhỏ nhất (cộng thêm group của các bản bị bỏ).
/// Kết quả sắp theo id.
fn dedup(accounts: &mut Vec<Account>) {
    accounts.sort_by(|a, b| a.id.cmp(&b.id));
    let mut kept: Vec<Account> = Vec::with_capacity(accounts.len());
    let mut index: HashMap<String, usize> = HashMap::new();
    for account in accounts.drain(..) {
        match index.get(&account.secret) {
            Some(&i) => {
                let groups = &mut kept[i].group_ids;
                groups.extend(account.group_ids);
                groups.sort();
                groups.dedup();
            }
            None => {
                index.insert(account.secret.clone(), kept.len());
                kept.push(account);
            }
        }
    }
    *accounts = kept;
}

/// Mỗi group lấy bản thay đổi sau cùng; bằng nhau thì bản đã xoá thắng. Sắp theo id.
fn merge_groups(local: &[Group], remote: &[Group]) -> Vec<Group> {
    let mut merged: BTreeMap<&str, &Group> = BTreeMap::new();
    for group in local.iter().chain(remote) {
        let newer = match merged.get(group.id.as_str()) {
            Some(current) => {
                (group.changed_at(), group.deleted_at.is_some())
                    > (current.changed_at(), current.deleted_at.is_some())
            }
            None => true,
        };
        if newer {
            merged.insert(&group.id, group);
        }
    }
    merged.into_values().cloned().collect()
}

/// Tài khoản trong `merged` mà `base` chưa có (khác id và khác secret).
fn new_in(merged: &[Account], base: &[Account]) -> Vec<AccountSummary> {
    let ids: HashSet<&str> = base.iter().map(|a| a.id.as_str()).collect();
    let secrets: HashSet<&str> = base.iter().map(|a| a.secret.as_str()).collect();
    merged
        .iter()
        .filter(|a| !ids.contains(a.id.as_str()) && !secrets.contains(a.secret.as_str()))
        .map(Account::summary)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::totp::Algorithm;

    fn account(id: &str, secret: &str, at: u64) -> Account {
        Account {
            id: id.into(),
            issuer: format!("Issuer {id}"),
            label: "me@example.com".into(),
            secret: secret.into(),
            algorithm: Algorithm::Sha1,
            digits: 6,
            period: 30,
            created_at: at,
            updated_at: at,
            group_ids: Vec::new(),
        }
    }

    fn tomb(account: Account, at: u64) -> Deleted {
        Deleted {
            id: account.id.clone(),
            deleted_at: at,
            account: Some(account),
        }
    }

    fn data(accounts: Vec<Account>, deleted: Vec<Deleted>) -> VaultData {
        VaultData {
            accounts,
            deleted,
            groups: Vec::new(),
        }
    }

    fn group(id: &str, name: &str, at: u64) -> Group {
        Group {
            id: id.into(),
            name: name.into(),
            hidden: false,
            updated_at: at,
            deleted_at: None,
        }
    }

    fn ids(data: &VaultData) -> Vec<&str> {
        data.accounts.iter().map(|a| a.id.as_str()).collect()
    }

    #[test]
    fn merges_accounts_added_on_both_sides() {
        let local = data(vec![account("a", "AAAA", 1), account("b", "BBBB", 1)], vec![]);
        let remote = data(vec![account("b", "BBBB", 1), account("c", "CCCC", 2)], vec![]);
        let merge = Merge::compute(&local, &remote);
        assert!(merge.pending().is_empty());
        assert_eq!(merge.added.len(), 1);
        assert_eq!(merge.added[0].id, "c");
        assert_eq!(merge.uploaded.len(), 1);
        assert_eq!(merge.uploaded[0].id, "a");

        let (result, summary) = merge.resolve(&[], 10);
        assert_eq!(ids(&result), ["a", "b", "c"]);
        assert_eq!((summary.added, summary.uploaded), (1, 1));
    }

    #[test]
    fn deletion_on_other_device_waits_for_confirmation() {
        let local = data(vec![account("a", "AAAA", 1), account("b", "BBBB", 1)], vec![]);
        let remote = data(vec![account("a", "AAAA", 1)], vec![tomb(account("b", "BBBB", 1), 5)]);
        let merge = Merge::compute(&local, &remote);
        let pending = merge.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!((pending[0].id.as_str(), pending[0].side), ("b", Side::Local));
        assert!(!pending[0].permanent);

        // Không xác nhận: giữ lại, thắng bản ghi xoá.
        let (kept, summary) = Merge::compute(&local, &remote).resolve(&[], 10);
        assert_eq!(ids(&kept), ["a", "b"]);
        assert!(kept.deleted.is_empty());
        assert_eq!(kept.accounts[1].changed_at(), 10);
        assert_eq!(summary.kept, 1);

        // Xác nhận: chuyển vào Thùng rác, vẫn còn dữ liệu.
        let (removed, summary) = merge.resolve(&["b".into()], 10);
        assert_eq!(ids(&removed), ["a"]);
        assert_eq!(removed.deleted[0].account.as_ref().unwrap().secret, "BBBB");
        assert_eq!(summary.deleted, 1);
    }

    #[test]
    fn deletion_on_this_device_also_waits_for_confirmation() {
        let local = data(vec![], vec![tomb(account("a", "AAAA", 1), 5)]);
        let remote = data(vec![account("a", "AAAA", 1)], vec![]);
        let merge = Merge::compute(&local, &remote);
        assert_eq!(merge.pending()[0].side, Side::Remote);

        let (result, _) = merge.resolve(&["a".into()], 10);
        assert!(result.accounts.is_empty());
        assert_eq!(result.deleted.len(), 1);

        // Kết quả gộp lần sau với chính nó không còn gì chờ xác nhận.
        assert!(Merge::compute(&result, &result).pending().is_empty());
    }

    #[test]
    fn account_restored_after_deletion_wins() {
        // Máy kia xoá lúc 5, máy này khôi phục từ Thùng rác lúc 8.
        let local = data(vec![account("a", "AAAA", 8)], vec![]);
        let remote = data(vec![], vec![tomb(account("a", "AAAA", 1), 5)]);
        let merge = Merge::compute(&local, &remote);
        assert!(merge.pending().is_empty());
        let (result, _) = merge.resolve(&[], 10);
        assert_eq!(ids(&result), ["a"]);
        assert!(result.deleted.is_empty());
    }

    #[test]
    fn same_secret_added_on_two_devices_is_merged() {
        let local = data(vec![account("b", "SAME", 1)], vec![]);
        let remote = data(vec![account("a", "SAME", 2)], vec![]);
        let merge = Merge::compute(&local, &remote);
        assert!(merge.added.is_empty() && merge.uploaded.is_empty());
        let (result, _) = merge.resolve(&[], 10);
        assert_eq!(ids(&result), ["a"]);
    }

    #[test]
    fn permanent_deletion_wins() {
        let mut purged = tomb(account("a", "AAAA", 1), 6);
        purged.account = None;
        let local = data(vec![], vec![tomb(account("a", "AAAA", 1), 5)]);
        let remote = data(vec![], vec![purged]);
        let (result, _) = Merge::compute(&local, &remote).resolve(&[], 10);
        assert!(result.deleted[0].account.is_none());
    }

    #[test]
    fn groups_take_latest_change_and_deletion_wins_ties() {
        let mut local = data(vec![], vec![]);
        let mut remote = data(vec![], vec![]);
        let mut renamed = group("g1", "Công việc", 5);
        renamed.hidden = true;
        local.groups = vec![group("g1", "Work", 1), group("g2", "Cá nhân", 1)];
        let mut deleted = group("g2", "Cá nhân", 1);
        deleted.deleted_at = Some(1);
        remote.groups = vec![renamed, deleted, group("g3", "Mới", 2)];

        let (result, _) = Merge::compute(&local, &remote).resolve(&[], 10);
        let names: Vec<(&str, &str, bool, bool)> = result
            .groups
            .iter()
            .map(|g| (g.id.as_str(), g.name.as_str(), g.hidden, g.active()))
            .collect();
        assert_eq!(
            names,
            [
                ("g1", "Công việc", true, true),
                ("g2", "Cá nhân", false, false),
                ("g3", "Mới", false, true)
            ]
        );
    }

    #[test]
    fn duplicate_accounts_keep_groups_of_both() {
        let mut a = account("a", "SAME", 1);
        a.group_ids = vec!["g1".into()];
        let mut b = account("b", "SAME", 1);
        b.group_ids = vec!["g2".into(), "g1".into()];
        let (result, _) = Merge::compute(&data(vec![b], vec![]), &data(vec![a], vec![])).resolve(&[], 10);
        assert_eq!(ids(&result), ["a"]);
        assert_eq!(result.accounts[0].group_ids, ["g1", "g2"]);
    }

    #[test]
    fn group_membership_follows_latest_account_change() {
        let mut moved = account("a", "AAAA", 5);
        moved.group_ids = vec!["g1".into()];
        let (result, _) = Merge::compute(
            &data(vec![account("a", "AAAA", 1)], vec![]),
            &data(vec![moved], vec![]),
        )
        .resolve(&[], 10);
        assert_eq!(result.accounts[0].group_ids, ["g1"]);
    }
}
