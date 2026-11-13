import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type CodeEntry,
  describeImport,
  errorMessage,
  filterEntries,
  type Group,
  type ImportResult,
} from "@auth/core";
import { CodeList, GroupBar, Icon, missingBatchNote, SearchBox, useCodes } from "@auth/ui";
import { fillCode, scanQrOnPage } from "./page";

type Notice = { kind: "success" | "error"; text: string } | null;

/** Filter group đang chọn, nhớ qua các lần mở popup. */
const FILTER_KEY = "groupFilter";

interface SavedFilter {
  selected: string | null;
  showHidden: boolean;
}

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
  /** null: chưa tải xong. */
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  /** Đã đọc filter đã lưu (trước đó không ghi đè, không kiểm tra). */
  const [filterLoaded, setFilterLoaded] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get(FILTER_KEY).then((stored) => {
      const saved = stored[FILTER_KEY] as Partial<SavedFilter> | undefined;
      setSelectedGroup(typeof saved?.selected === "string" ? saved.selected : null);
      setShowHidden(saved?.showHidden === true);
      setFilterLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!filterLoaded) return;
    const value: SavedFilter = { selected: selectedGroup, showHidden };
    void chrome.storage.local.set({ [FILTER_KEY]: value });
  }, [filterLoaded, selectedGroup, showHidden]);

  // Lỗi (ví dụ app desktop bản cũ chưa có group) thì coi như không có group.
  const refreshGroups = useCallback(
    () => listGroups().then(setGroups, () => setGroups((current) => current ?? [])),
    [listGroups],
  );

  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);

  useEffect(() => {
    if (reloadKey > 0) void Promise.all([refresh(), refreshGroups()]);
  }, [reloadKey, refresh, refreshGroups]);

  useEffect(() => {
    // Chờ tải xong group và filter đã lưu, không thì filter bị xoá ngay lúc mở popup.
    if (!groups || !filterLoaded) return;
    const group = groups.find((g) => g.id === selectedGroup);
    if (selectedGroup && (!group || (group.hidden && !showHidden))) setSelectedGroup(null);
  }, [groups, filterLoaded, selectedGroup, showHidden]);

  const groupList = groups ?? [];

  const visible = useMemo(
    () => filterEntries(entries, groupList, { selected: selectedGroup, showHidden, query }),
    [entries, groupList, selectedGroup, showHidden, query],
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
      const missing = missingBatchNote(uris);
      setNotice({
        kind: "success",
        text: describeImport(result) + (missing ? ` Lưu ý: ${missing}.` : ""),
      });
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
        groups={groupList}
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
            groups={groupList}
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
