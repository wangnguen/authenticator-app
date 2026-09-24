interface Props {
  value: string;
  onChange: (value: string) => void;
}

export function SearchBox({ value, onChange }: Props) {
  return (
    <input
      className="auth-input auth-search"
      type="search"
      placeholder="Tìm tài khoản..."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoFocus
    />
  );
}
