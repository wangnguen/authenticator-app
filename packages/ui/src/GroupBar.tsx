import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  restrictToFirstScrollableAncestor,
  restrictToHorizontalAxis,
} from "@dnd-kit/modifiers";
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Group } from "@auth/core";
import { Icon } from "./Icon";
import { DRAG_THRESHOLD, mergeOrder, movedIds, sortableA11y } from "./Sortable";

interface Props {
  /** Theo thứ tự hiển thị. */
  groups: Group[];
  /** Group đang chọn; null = "Tất cả". */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Đang hiện cả group ẩn. */
  showHidden: boolean;
  onToggleHidden: () => void;
  /**
   * Có thì kéo thả được chip để đổi thứ tự; nhận thứ tự mới của **mọi** group (kể cả group ẩn
   * đang không hiện, giữ nguyên chỗ của chúng). "Tất cả" luôn đứng đầu, không kéo được.
   */
  onReorder?: (ids: string[]) => void;
  /** Nút thêm ở cuối hàng (ví dụ: tạo / quản lý group trong app desktop). */
  actions?: ReactNode;
}

/**
 * Hàng chip lọc theo group: "Tất cả" cố định ở đầu, các group cuộn ngang được (kéo thả để sắp
 * xếp), nút hiện/ẩn group ẩn và `actions` cố định ở cuối.
 */
export function GroupBar({
  groups,
  selected,
  onSelect,
  showHidden,
  onToggleHidden,
  onReorder,
  actions,
}: Props) {
  const hiddenCount = groups.filter((g) => g.hidden).length;
  const visible = groups.filter((g) => showHidden || !g.hidden);
  const [dragging, setDragging] = useState(false);
  const shown = groups.length > 0 || !!actions;
  const scroller = useHorizontalScroll(shown);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_THRESHOLD } }),
  );

  // Group đang chọn (vd. nhớ từ lần trước) nằm khuất bên phải: cuộn tới cho thấy.
  useEffect(() => {
    if (!selected) return;
    const el = scroller.ref.current?.querySelector<HTMLElement>(
      `[data-group-id="${CSS_escape(selected)}"]`,
    );
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, scroller.ref, visible.length]);

  if (!shown) return null;

  // Cú click lúc thả chuột sau khi kéo đã bị dnd-kit chặn, không chọn nhầm chip.
  const end = (event: DragEndEvent) => {
    setDragging(false);
    const next = movedIds(
      visible.map((g) => g.id),
      event,
    );
    if (!onReorder || !next) return;
    // Group ẩn (đang không hiện) giữ nguyên chỗ.
    onReorder(
      mergeOrder(
        groups.map((g) => g.id),
        next,
      ),
    );
  };

  const chips = visible.map((group) => (
    <GroupChip
      key={group.id}
      group={group}
      active={selected === group.id}
      draggable={!!onReorder}
      onClick={() => onSelect(selected === group.id ? null : group.id)}
    />
  ));

  return (
    <div
      className={dragging ? "auth-groups auth-groups--dragging" : "auth-groups"}
      role="tablist"
      aria-label="Lọc theo group"
    >
      <button
        role="tab"
        aria-selected={selected === null}
        className={selected === null ? "auth-chip auth-chip--active" : "auth-chip"}
        onClick={() => onSelect(null)}
      >
        Tất cả
      </button>
      <div
        ref={scroller.ref}
        className={[
          "auth-groups__scroll",
          scroller.left && "auth-groups__scroll--left",
          scroller.right && "auth-groups__scroll--right",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {onReorder ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis, restrictToFirstScrollableAncestor]}
            accessibility={sortableA11y(
              (id) => groups.find((g) => g.id === id)?.name ?? "",
              false,
            )}
            onDragStart={() => setDragging(true)}
            onDragEnd={end}
            onDragCancel={() => setDragging(false)}
          >
            <SortableContext items={visible.map((g) => g.id)} strategy={horizontalListSortingStrategy}>
              {chips}
            </SortableContext>
          </DndContext>
        ) : (
          chips
        )}
      </div>
      {hiddenCount > 0 && (
        <button
          className="auth-chip auth-chip--ghost"
          onClick={onToggleHidden}
          title={showHidden ? "Không hiện group ẩn" : "Hiện cả group ẩn"}
          aria-pressed={showHidden}
        >
          <Icon name={showHidden ? "eye-off" : "eye"} />
          {showHidden ? "Giấu" : `${hiddenCount} ẩn`}
        </button>
      )}
      {actions}
    </div>
  );
}

interface ChipProps {
  group: Group;
  active: boolean;
  draggable: boolean;
  onClick: () => void;
}

function GroupChip({ group, active, draggable, onClick }: ChipProps) {
  const className = [
    "auth-chip",
    draggable && "auth-chip--draggable",
    active && "auth-chip--active",
    group.hidden && "auth-chip--hidden",
  ];
  const title =
    (group.hidden ? `${group.name} (đang ẩn)` : group.name) + (draggable ? ". Kéo để đổi vị trí" : "");
  const content = (
    <>
      {group.name}
      <span className="auth-chip__count">{group.count}</span>
    </>
  );
  if (!draggable) {
    return (
      <button
        role="tab"
        data-group-id={group.id}
        aria-selected={active}
        className={className.filter(Boolean).join(" ")}
        onClick={onClick}
        title={title}
      >
        {content}
      </button>
    );
  }
  return <SortableChip group={group} className={className} title={title} active={active} onClick={onClick}>{content}</SortableChip>;
}

function SortableChip({
  group,
  className,
  title,
  active,
  onClick,
  children,
}: {
  group: Group;
  className: (string | false)[];
  title: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: group.id });
  return (
    <button
      ref={setNodeRef}
      role="tab"
      data-group-id={group.id}
      aria-selected={active}
      className={[...className, isDragging && "auth-chip--dragged"].filter(Boolean).join(" ")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={onClick}
      title={title}
      {...listeners}
    >
      {children}
    </button>
  );
}

/** `CSS.escape` nếu có (trình duyệt), không thì giữ nguyên (id là uuid, không có ký tự lạ). */
function CSS_escape(value: string): string {
  return typeof globalThis.CSS?.escape === "function" ? globalThis.CSS.escape(value) : value;
}

/**
 * Vùng cuộn ngang: lăn chuột dọc cũng cuộn ngang, và báo còn nội dung khuất bên trái / phải
 * (để làm mờ mép).
 */
function useHorizontalScroll(rendered: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    const resize = new ResizeObserver(update);
    resize.observe(el);
    for (const child of el.children) resize.observe(child);
    const mutation = new MutationObserver(() => {
      for (const child of el.children) resize.observe(child);
      update();
    });
    mutation.observe(el, { childList: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", update);
    };
    // Gắn lại khi thanh chip mới hiện ra (lúc đầu chưa có group thì chưa có phần tử).
  }, [update, rendered]);

  return { ref, ...edges };
}
