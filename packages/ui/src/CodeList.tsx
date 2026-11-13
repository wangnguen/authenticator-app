import type { ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type CodeEntry, type Group, matchesQuery } from "@auth/core";
import { CodeCard } from "./CodeCard";
import { DRAG_THRESHOLD, movedIds, sortableA11y } from "./Sortable";

interface Props {
  entries: CodeEntry[];
  now: number;
  query?: string;
  emptyText?: string;
  renderActions?: (entry: CodeEntry) => ReactNode;
  /** Có thì hiện tên group trên từng thẻ. */
  groups?: Group[];
  /**
   * Có thì nhấn giữ rồi kéo thẻ để đổi vị trí (tắt khi đang tìm kiếm); nhận thứ tự mới của các
   * thẻ đang hiện. Bấm nhanh vẫn là copy mã.
   */
  onReorder?: (ids: string[]) => void;
}

export function CodeList({
  entries,
  now,
  query = "",
  emptyText = "Chưa có tài khoản nào.",
  renderActions,
  groups,
  onReorder,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_THRESHOLD } }),
  );
  const visible = entries.filter((e) => matchesQuery(e, query));

  if (visible.length === 0) {
    return (
      <p className="auth-empty">{query ? "Không tìm thấy." : emptyText}</p>
    );
  }

  const sortable = !!onReorder && !query.trim() && visible.length > 1;
  const card = (entry: CodeEntry) => {
    const props = {
      entry,
      now,
      actions: renderActions?.(entry),
      tags: groups?.filter((g) => entry.groupIds?.includes(g.id)).map((g) => g.name),
    };
    return sortable ? (
      <SortableCard key={entry.id} {...props} />
    ) : (
      <CodeCard key={entry.id} {...props} />
    );
  };

  if (!sortable) return <ul className="auth-list">{visible.map(card)}</ul>;

  const ids = visible.map((e) => e.id);
  const nameOf = (id: unknown) => {
    const entry = visible.find((e) => e.id === id);
    return entry ? entry.issuer || entry.label : "";
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      accessibility={sortableA11y(nameOf, false)}
      onDragEnd={(event) => {
        const next = movedIds(ids, event);
        if (next) onReorder(next);
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="auth-list">{visible.map(card)}</ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableCard(props: {
  entry: CodeEntry;
  now: number;
  actions?: ReactNode;
  tags?: string[];
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: props.entry.id,
  });
  return (
    <CodeCard
      {...props}
      draggable
      itemProps={{
        ref: setNodeRef,
        className: isDragging ? "auth-card--sortable auth-card--dragging" : "auth-card--sortable",
        style: { transform: CSS.Translate.toString(transform), transition },
        ...listeners,
      }}
    />
  );
}
