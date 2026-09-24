import { useCallback, useEffect, useState } from "react";
import { errorMessage, type CodeEntry } from "@auth/core";

/**
 * Lấy danh sách mã OTP và tự refetch khi mã sớm nhất hết hạn.
 * `now` cập nhật mỗi 250ms để vẽ đồng hồ đếm ngược.
 */
export function useCodes(
  fetcher: () => Promise<CodeEntry[]>,
  enabled = true,
) {
  const [entries, setEntries] = useState<CodeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setEntries(await fetcher());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || entries.length === 0) return;
    const soonest = Math.min(...entries.map((e) => e.expiresAt));
    const timer = setTimeout(
      () => void refresh(),
      Math.max(soonest - Date.now(), 0) + 100,
    );
    return () => clearTimeout(timer);
  }, [enabled, entries, refresh]);

  return { entries, error, loading, now, refresh };
}
