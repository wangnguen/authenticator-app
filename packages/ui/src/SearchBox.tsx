import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { ServiceOption } from "@auth/core";
import { Icon } from "./Icon";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /**
   * Có thì hiện nút chọn dịch vụ ở bên phải ô tìm kiếm (lọc theo chữ in đậm trên thẻ: Applovin,
   * OpenVPN...).
   */
  services?: ServiceOption[];
  /** `ServiceOption.key` đang chọn; null = "Tất cả". */
  service?: string | null;
  onServiceChange?: (key: string | null) => void;
  /** Số tài khoản ứng với "Tất cả". */
  allCount?: number;
}

export function SearchBox({ value, onChange, services, service = null, onServiceChange, allCount }: Props) {
  const picker = services && onServiceChange;
  return (
    <div className={picker ? "auth-search-box auth-search-box--picker" : "auth-search-box"}>
      <input
        className="auth-input auth-search"
        type="search"
        placeholder="Tìm tài khoản..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
      />
      {picker && (
        <ServicePicker
          services={services}
          selected={service}
          onSelect={onServiceChange}
          allCount={allCount}
        />
      )}
    </div>
  );
}

interface PickerProps {
  services: ServiceOption[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  allCount?: number;
}

/** Nút "Tất cả ▾" trong ô tìm kiếm, mở danh sách dịch vụ có ô lọc riêng. */
function ServicePicker({ services, selected, onSelect, allCount }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const current = services.find((s) => s.key === selected);
  // Dịch vụ đang chọn không còn trong danh sách (vd. group đang chọn không có) vẫn hiện để bỏ chọn.
  const all =
    selected && !current ? [{ key: selected, name: selected, count: 0 }, ...services] : services;
  const q = filter.trim().toLowerCase();
  const options: { key: string | null; name: string; count?: number }[] = [
    { key: null, name: "Tất cả", count: allCount },
    ...all.filter((s) => s.name.toLowerCase().includes(q)),
  ];

  // Bấm ra ngoài thì đóng.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const show = () => {
    setFilter("");
    const index = Math.max(0, all.findIndex((s) => s.key === selected) + 1);
    setActive(selected ? index : 0);
    setOpen(true);
  };

  const choose = (key: string | null) => {
    onSelect(key);
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = options[active];
      if (option) choose(option.key);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  };

  return (
    <div className="auth-service" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={selected ? "auth-service__trigger auth-service__trigger--set" : "auth-service__trigger"}
        onClick={() => (open ? setOpen(false) : show())}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Lọc theo dịch vụ"
      >
        <span className="auth-service__value">{selected ? (current?.name ?? selected) : "Tất cả"}</span>
        {!selected && <Icon name="chevron-down" size={14} />}
      </button>
      {selected && (
        <button
          type="button"
          className="auth-service__clear"
          onClick={() => choose(null)}
          title="Bỏ lọc dịch vụ"
          aria-label="Bỏ lọc dịch vụ"
        >
          <Icon name="x" size={14} />
        </button>
      )}
      {open && (
        <div className="auth-service__menu">
          <input
            className="auth-input auth-service__filter"
            placeholder="Lọc dịch vụ..."
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(e.target.value.trim() ? 1 : 0);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-controls={listId}
            aria-expanded
            aria-activedescendant={`${listId}-${active}`}
            autoFocus
          />
          <ul className="auth-service__list" role="listbox" id={listId} ref={list}>
            {options.map((option, i) => (
              <li
                key={option.key ?? ""}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={option.key === selected}
                className={[
                  "auth-service__option",
                  i === active && "auth-service__option--active",
                  option.key === selected && "auth-service__option--selected",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onPointerMove={() => setActive(i)}
                onClick={() => choose(option.key)}
              >
                <span className="auth-service__check">
                  {option.key === selected && <Icon name="check" size={14} />}
                </span>
                <span className="auth-service__name">{option.name}</span>
                {option.count !== undefined && (
                  <span className="auth-service__count">{option.count}</span>
                )}
              </li>
            ))}
            {options.length === 1 && q && <li className="auth-service__empty">Không có dịch vụ nào.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
