import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type CodeEntry,
  describeImport,
  errorMessage,
  filterEntries,
  type Group,
  type ImportResult,
} from "@auth/core";
import { CodeList, GroupBar, Icon, SearchBox, useCodes } from "@auth/ui";
import { fillCode, scanQrOnPage } from "./page";

type Notice = { kind: "success" | "error"; text: string } | null;

interface Props {
  /** Phải là hàm cố định (không tạo mới mỗi lần render), vì `useCodes` gọi lại khi nó đổi. */
  list: () => Promise<CodeEntry[]>;
  /** Group để lọc (quản lý group trong app desktop). Cũng phải là hàm cố định. */
  listGroups: () => Promise<Group[]>;
  /** Thêm tài khoản từ các link otpauth đọc được trên trang. */
  add: (uris: string) => Promise<ImportResult>;
  emptyText: string;
  /** Đổi giá trị để tải lại danh sách (sau khi đồng bộ) mà giữ nguyên ô tìm kiếm, thông báo. */
  reloadKey?: number;
}

/** Danh sách mã: tìm kiếm, điền mã vào trang, quét QR trên trang để thêm tài khoản. */
export function Codes({ list, listGroups, add, emptyText, reloadKey = 0 }: Props) {
  const { entries, error, loading, now, refresh } = useCodes(list);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [scanning, setScanning] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  // Lỗi (ví dụ app desktop bản cũ chưa có group) thì coi như không có group.
  const refreshGroups = useCallback(
    () => listGroups().then(setGroups, () => setGroups([])),
    [listGroups],
  );

  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);

  useEffect(() => {
    if (reloadKey > 0) void Promise.all([refresh(), refreshGroups()]);
  }, [reloadKey, refresh, refreshGroups]);

  useEffect(() => {
    const group = groups.find((g) => g.id === selectedGroup);
    if (selectedGroup && (!group || (group.hidden && !showHidden))) setSelectedGroup(null);
  }, [groups, selectedGroup, showHidden]);

  const visible = useMemo(
    () => filterEntries(entries, groups, { selected: selectedGroup, showHidden, query }),
    [entries, groups, selectedGroup, showHidden, query],
  );

  const fill = async (code: string) => {
    try {
      if (await fillCode(code)) window.close();
      else setNotice({ kind: "error", text: "Không tìm thấy ô nhập mã trên trang." });
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e) });
    }
  };

  const scan = async () => {
    setScanning(true);
    setNotice(null);
    try {
      const uris = await scanQrOnPage();
      if (uris.length === 0) {
        setNotice({ kind: "error", text: "Không thấy QR code 2FA trên trang." });
        return;
      }
      const result = await add(uris.join("\n"));
      setNotice({ kind: "success", text: describeImport(result) });
      await refresh();
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e) });
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      <div className="popup__toolbar">
        <SearchBox value={query} onChange={setQuery} />
        <button className="auth-btn" onClick={scan} disabled={scanning} title="Quét QR trên trang">
          {scanning ? (
            "..."
          ) : (
            <>
              <Icon name="camera" /> QR
            </>
          )}
        </button>
      </div>
      <GroupBar
        groups={groups}
        selected={selectedGroup}
        onSelect={setSelectedGroup}
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden((v) => !v)}
      />
      {notice && (
        <p className={notice.kind === "success" ? "auth-success" : "auth-error"}>{notice.text}</p>
      )}
      {error && <p className="auth-error">{error}</p>}
      {!loading && (
        <div className="popup__list">
          <CodeList
            entries={visible}
            now={now}
            query={query}
            groups={groups}
            emptyText={
              selectedGroup
                ? "Group này chưa có tài khoản."
                : entries.length > 0
                  ? "Mọi tài khoản đều thuộc group đang ẩn."
                  : emptyText
            }
            renderActions={(entry) => (
              <button
                className="auth-btn auth-btn--small"
                onClick={() => fill(entry.code)}
                title="Điền mã vào trang"
              >
                Điền
              </button>
            )}
          />
        </div>
      )}
    </>
  );
}
