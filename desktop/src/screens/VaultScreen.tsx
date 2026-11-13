import { useCallback, useEffect, useMemo, useState } from "react";
import { type CodeEntry, errorMessage, filterEntries, type Group } from "@auth/core";
import { CodeList, GroupBar, Icon, mergeOrder, SearchBox, useCodes } from "@auth/ui";
import { api } from "../api";
import { AccountGroupsDialog } from "./AccountGroupsDialog";
import { AddAccountDialog } from "./AddAccountDialog";
import { ExtensionDialog } from "./ExtensionDialog";
import { GoogleAccountMenu } from "./GoogleAccountMenu";
import { GroupsDialog } from "./GroupsDialog";
import { SecurityDialog } from "./SecurityDialog";
import { TrashDialog } from "./TrashDialog";

/** Filter group đang chọn, nhớ qua các lần mở app. */
const FILTER_KEY = "auth.groupFilter";

function savedFilter(): { selected: string | null; showHidden: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") as {
      selected?: unknown;
      showHidden?: unknown;
    };
    return {
      selected: typeof value.selected === "string" ? value.selected : null,
      showHidden: value.showHidden === true,
    };
  } catch {
    return { selected: null, showHidden: false };
  }
}

interface Props {
  /** false: vault không mật khẩu, ẩn nút khoá vì mở lại không cần gì. */
  hasPassword: boolean;
  onLock: () => void;
  onSecurityChanged: () => void;
}

export function VaultScreen({ hasPassword, onLock, onSecurityChanged }: Props) {
  const { entries, error, loading, now, refresh, reorder } = useCodes(api.listCodes);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<Group[] | null>(null);
  /** Group đang chọn trên thanh lọc; null = "Tất cả". Nhớ qua các lần mở app. */
  const [selectedGroup, setSelectedGroup] = useState<string | null>(() => savedFilter().selected);
  const [showHidden, setShowHidden] = useState(() => savedFilter().showHidden);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsFor, setGroupsFor] = useState<CodeEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashCount, setTrashCount] = useState(0);
  /** Tăng khi vault trên máy đổi do người dùng hoặc extension: kích hoạt tự đồng bộ. */
  const [changeCount, setChangeCount] = useState(0);
  const [syncAttention, setSyncAttention] = useState<string | null>(null);
  const [attentionRequest, setAttentionRequest] = useState(0);
  const changed = useCallback(() => setChangeCount((n) => n + 1), []);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const refreshTrash = useCallback(
    () => api.listTrash().then((t) => setTrashCount(t.length), () => setTrashCount(0)),
    [],
  );

  const refreshGroups = useCallback(
    () => api.listGroups().then(setGroups, () => setGroups((current) => current ?? [])),
    [],
  );

  /** Tải lại danh sách mã, group và số tài khoản trong Thùng rác. */
  const reload = useCallback(async () => {
    await Promise.all([refresh(), refreshTrash(), refreshGroups()]);
  }, [refresh, refreshTrash, refreshGroups]);

  useEffect(() => {
    void refreshTrash();
    void refreshGroups();
  }, [refreshTrash, refreshGroups]);

  // Group đang chọn bị xoá, hoặc bị ẩn trong lúc không hiện group ẩn: quay về "Tất cả".
  useEffect(() => {
    // Chờ tải xong danh sách group, không thì filter đã lưu bị xoá ngay lúc mở app.
    if (!groups) return;
    const group = groups.find((g) => g.id === selectedGroup);
    if (selectedGroup && (!group || (group.hidden && !showHidden))) setSelectedGroup(null);
  }, [groups, selectedGroup, showHidden]);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ selected: selectedGroup, showHidden }));
  }, [selectedGroup, showHidden]);

  /** Kéo thả chip: đổi thứ tự trên giao diện ngay, rồi lưu (và tự đồng bộ). */
  const reorderGroups = async (ids: string[]) => {
    setGroups((current) =>
      current ? ids.map((id) => current.find((g) => g.id === id)).filter((g): g is Group => !!g) : current,
    );
    try {
      setGroups(await api.reorderGroups(ids));
      changed();
    } catch (e) {
      setActionError(errorMessage(e));
      void refreshGroups();
    }
  };

  /** Kéo thả thẻ tài khoản: `shown` là thứ tự mới của các thẻ đang hiện (đang lọc theo group thì
   * tài khoản ngoài group giữ nguyên chỗ). */
  const reorderAccounts = async (shown: string[]) => {
    const ids = mergeOrder(
      entries.map((e) => e.id),
      shown,
    );
    reorder(ids);
    try {
      await api.reorderAccounts(ids);
      changed();
    } catch (e) {
      setActionError(errorMessage(e));
      void refresh();
    }
  };

  const groupList = groups ?? [];

  const visible = useMemo(
    () => filterEntries(entries, groupList, { selected: selectedGroup, showHidden, query }),
    [entries, groupList, selectedGroup, showHidden, query],
  );
  const hiddenAccounts = entries.length - filterEntries(entries, groupList, {
    selected: null,
    showHidden: false,
    query: "",
  }).length;

  useEffect(() => {
    const unlisten = api.onVaultChanged(() => {
      void reload();
      changed();
    });
    return () => void unlisten.then((fn) => fn());
  }, [reload, changed]);

  const remove = async (id: string) => {
    if (confirmDelete !== id) {
      setConfirmDelete(id);
      return;
    }
    try {
      const entry = entries.find((e) => e.id === id);
      await api.deleteAccount(id);
      setConfirmDelete(null);
      setNotice(`Đã chuyển ${entry?.issuer || entry?.label || "tài khoản"} vào Thùng rác.`);
      changed();
      await reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  return (
    <main className="page">
      <header className="toolbar">
        <h1>Authenticator</h1>
        <div className="toolbar__actions">
          <button className="auth-btn auth-btn--primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Thêm
          </button>
          <button
            className="auth-btn auth-btn--icon"
            onClick={() => setExtensionOpen(true)}
            title="Kết nối extension"
          >
            <Icon name="puzzle" size={18} />
          </button>
          <button
            className="auth-btn auth-btn--icon"
            onClick={() => setSecurityOpen(true)}
            title="Bảo mật"
          >
            <Icon name="settings" size={18} />
          </button>
          {hasPassword && (
            <button className="auth-btn auth-btn--icon" onClick={onLock} title="Khoá vault">
              <Icon name="lock" size={18} />
            </button>
          )}
          <GoogleAccountMenu
            hasPassword={hasPassword}
            onRestored={() => {
              // Bản JSON không mã hoá khôi phục xong vẫn mở sẵn, nên tải lại danh sách mã.
              onSecurityChanged();
              void reload();
            }}
            onSynced={() => void reload()}
            changeCount={changeCount}
            attentionRequest={attentionRequest}
            onAttention={setSyncAttention}
          />
        </div>
      </header>

      {syncAttention && (
        <div className="sync-banner">
          <span>⚠ {syncAttention}</span>
          <button
            className="auth-btn auth-btn--small"
            onClick={() => setAttentionRequest((n) => n + 1)}
          >
            Xem
          </button>
        </div>
      )}

      <SearchBox value={query} onChange={setQuery} />

      <GroupBar
        groups={groupList}
        selected={selectedGroup}
        onSelect={setSelectedGroup}
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden((v) => !v)}
        onReorder={(ids) => void reorderGroups(ids)}
        actions={
          <button
            className="auth-chip auth-chip--ghost"
            onClick={() => setGroupsOpen(true)}
            title="Tạo, đổi tên, ẩn/hiện, xoá group"
          >
            <Icon name="tag" /> {groupList.length === 0 ? "Tạo group" : "Quản lý"}
          </button>
        }
      />

      {notice && <p className="auth-success">{notice}</p>}
      {(error || actionError) && <p className="auth-error">{error ?? actionError}</p>}

      {!loading && (
        <CodeList
          entries={visible}
          now={now}
          query={query}
          groups={groupList}
          onReorder={(ids) => void reorderAccounts(ids)}
          emptyText={
            selectedGroup
              ? 'Group này chưa có tài khoản. Bấm nút nhãn trên một tài khoản để thêm vào group.'
              : entries.length > 0
                ? "Mọi tài khoản đều thuộc group đang ẩn."
                : 'Chưa có tài khoản nào. Bấm "+ Thêm" để bắt đầu.'
          }
          renderActions={(entry) => (
            <div className="card-actions">
              <button
                className="auth-btn auth-btn--small"
                onClick={() => setGroupsFor(entry)}
                title="Chọn group cho tài khoản"
              >
                <Icon name="tag" />
              </button>
              <button
                className="auth-btn auth-btn--small auth-btn--danger"
                onClick={() => remove(entry.id)}
                onBlur={() => setConfirmDelete(null)}
              >
                {confirmDelete === entry.id ? "Xác nhận?" : "Xoá"}
              </button>
            </div>
          )}
        />
      )}

      {!loading && !selectedGroup && !showHidden && !query && hiddenAccounts > 0 && (
        <p className="auth-muted hint">
          {hiddenAccounts} tài khoản thuộc group đang ẩn.{" "}
          <button className="link-btn" onClick={() => setShowHidden(true)}>
            Hiện
          </button>
        </p>
      )}

      {trashCount > 0 && (
        <button
          className="auth-btn auth-btn--small trash-link"
          onClick={() => setTrashOpen(true)}
          title="Tài khoản đã xoá, khôi phục được"
        >
          <Icon name="trash" /> Thùng rác ({trashCount})
        </button>
      )}

      {trashOpen && (
        <TrashDialog
          onClose={() => setTrashOpen(false)}
          onChanged={() => {
            changed();
            void reload();
          }}
        />
      )}

      {groupsOpen && (
        <GroupsDialog
          onClose={() => setGroupsOpen(false)}
          onChanged={() => {
            changed();
            void reload();
          }}
        />
      )}

      {groupsFor && (
        <AccountGroupsDialog
          entry={groupsFor}
          groups={groupList}
          onClose={() => {
            setGroupsFor(null);
            // Có thể đã tạo group mới trong hộp thoại rồi bấm Huỷ.
            void refreshGroups();
          }}
          onSaved={() => {
            setGroupsFor(null);
            changed();
            void reload();
          }}
        />
      )}

      {extensionOpen && <ExtensionDialog onClose={() => setExtensionOpen(false)} />}

      {securityOpen && (
        <SecurityDialog
          hasPassword={hasPassword}
          onChanged={onSecurityChanged}
          onClose={() => setSecurityOpen(false)}
        />
      )}

      {adding && (
        <AddAccountDialog
          onClose={() => setAdding(false)}
          onAdded={(message) => {
            setAdding(false);
            setNotice(message);
            changed();
            void refresh();
          }}
          onImported={() => {
            changed();
            void reload();
          }}
        />
      )}
    </main>
  );
}
