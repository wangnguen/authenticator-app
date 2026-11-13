import type { ReactNode } from "react";
import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/** Phải di chuyển quá khoảng này (px) mới tính là kéo, không thì là bấm. */
export const DRAG_THRESHOLD = 5;

/**
 * Lời đọc cho trình đọc màn hình khi kéo thả (tiếng Việt, gọi theo tên thay vì id), gắn vào
 * `document.body` để không chen phần tử ẩn vào trong danh sách.
 */
export function sortableA11y(nameOf: (id: UniqueIdentifier) => string, keyboard: boolean) {
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Đang kéo ${nameOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${nameOf(active.id)} đang ở chỗ ${nameOf(over.id)}.` : `${nameOf(active.id)}.`,
    onDragEnd: ({ active, over }) =>
      over ? `Đã thả ${nameOf(active.id)} vào chỗ ${nameOf(over.id)}.` : `Đã thả ${nameOf(active.id)}.`,
    onDragCancel: ({ active }) => `Huỷ kéo ${nameOf(active.id)}.`,
  };
  return {
    container: typeof document === "undefined" ? undefined : document.body,
    announcements,
    screenReaderInstructions: {
      draggable: keyboard
        ? "Nhấn Space để cầm, dùng phím mũi tên để di chuyển, Space lần nữa để thả, Esc để huỷ."
        : "Kéo bằng chuột để đổi vị trí.",
    },
  };
}

/** Ghép thứ tự mới sau khi thả: đưa `active` tới chỗ của `over`. Null nếu không đổi gì. */
export function movedIds(ids: string[], { active, over }: DragEndEvent): string[] | null {
  if (!over || active.id === over.id) return null;
  const from = ids.indexOf(String(active.id));
  const to = ids.indexOf(String(over.id));
  return from < 0 || to < 0 ? null : arrayMove(ids, from, to);
}

/**
 * Ghép thứ tự mới của một phần danh sách (các mục đang hiện, sau khi kéo thả) vào danh sách đầy
 * đủ: mục đang hiện lấp lần lượt các chỗ cũ của chúng, mục đang ẩn (lọc) giữ nguyên chỗ.
 */
export function mergeOrder(all: string[], shown: string[]): string[] {
  const inShown = new Set(shown);
  const queue = [...shown];
  return all.map((id) => (inShown.has(id) ? queue.shift()! : id));
}

interface ListProps<T> {
  items: T[];
  getId: (item: T) => string;
  getName: (item: T) => string;
  /** Thứ tự mới (id) sau khi kéo thả. */
  onReorder: (ids: string[]) => void;
  className?: string;
  itemClassName?: string;
  /** Dòng không kéo được lúc này (vd. đang sửa tên trong ô nhập). */
  isLocked?: (item: T) => boolean;
  renderItem: (item: T) => ReactNode;
}

/**
 * Danh sách dọc kéo thả được: nhấn giữ bất kỳ chỗ nào trên dòng rồi kéo; bấm nhanh (không kéo)
 * thì các nút trong dòng vẫn bấm bình thường.
 */
export function SortableList<T>({
  items,
  getId,
  getName,
  onReorder,
  className,
  itemClassName,
  isLocked,
  renderItem,
}: ListProps<T>) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_THRESHOLD } }),
  );
  const ids = items.map(getId);
  const names = new Map(items.map((item) => [getId(item), getName(item)]));
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      accessibility={sortableA11y((id) => names.get(String(id)) ?? "", false)}
      onDragEnd={(event) => {
        const next = movedIds(ids, event);
        if (next) onReorder(next);
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className={className}>
          {items.map((item) => (
            <SortableRow
              key={getId(item)}
              id={getId(item)}
              className={itemClassName}
              locked={isLocked?.(item) ?? false}
            >
              {renderItem(item)}
            </SortableRow>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  id,
  className,
  locked,
  children,
}: {
  id: string;
  className?: string;
  locked: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id,
    disabled: locked,
  });
  return (
    <li
      ref={setNodeRef}
      className={[
        className,
        "auth-sortable",
        !locked && "auth-sortable--grab",
        isDragging && "auth-sortable--dragging",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      title={locked ? undefined : "Kéo để đổi vị trí"}
      {...listeners}
    >
      {children}
    </li>
  );
}
