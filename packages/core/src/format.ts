/** "123456" -> "123 456", "12345678" -> "1234 5678". */
export function formatCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function matchesQuery(
  entry: { issuer: string; label: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.issuer.toLowerCase().includes(q) ||
    entry.label.toLowerCase().includes(q)
  );
}
