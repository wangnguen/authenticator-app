/**
 * Icon giao diện dùng chung. Mỗi icon là một file SVG trong `assets/icons/<tên>.svg` ở gốc repo;
 * thay file đó là đổi icon ở mọi nơi (app desktop + extension). SVG nên dùng
 * `stroke="currentColor"` / `fill="currentColor"` để icon tự lấy màu chữ.
 */
const files = import.meta.glob<string>("../../../assets/icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

const icons: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, svg]) => [path.slice(path.lastIndexOf("/") + 1, -4), svg]),
);

export type IconName =
  | "camera"
  | "check"
  | "cloud-upload"
  | "download"
  | "folder-open"
  | "lock"
  | "lock-open"
  | "plus"
  | "puzzle"
  | "settings"
  | "shield-lock";

interface Props {
  name: IconName;
  /** Cạnh icon (px). Mặc định 16. */
  size?: number;
  /** Có title thì icon được đọc bởi trình đọc màn hình; không thì chỉ để trang trí. */
  title?: string;
  className?: string;
}

export function Icon({ name, size = 16, title, className }: Props) {
  const svg = icons[name];
  if (!svg) {
    console.warn(`Thiếu icon assets/icons/${name}.svg`);
    return null;
  }
  return (
    <span
      className={className ? `auth-icon ${className}` : "auth-icon"}
      style={{ width: size, height: size }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      // SVG là file tĩnh trong repo (không phải dữ liệu người dùng) nên chèn trực tiếp được.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
