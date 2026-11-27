export interface ActiveFileDrag {
  path: string;
  label: string;
  x: number;
  y: number;
}

export type FileDragEvent =
  | { type: "move"; drag: ActiveFileDrag }
  | { type: "drop"; drag: ActiveFileDrag }
  | { type: "cancel" };

type Listener = (event: FileDragEvent) => void;

const DRAG_THRESHOLD_PX = 5;
const listeners = new Set<Listener>();
let activeCleanup: (() => void) | null = null;

function emit(event: FileDragEvent) {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

export function subscribeFileDrag(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function cancelActiveFileDrag() {
  activeCleanup?.();
}

export function startFileDrag({
  path,
  label,
  startX,
  startY,
  pointerId,
  onStarted,
}: {
  path: string;
  label: string;
  startX: number;
  startY: number;
  pointerId: number;
  onStarted?: () => void;
}) {
  activeCleanup?.();

  let active = false;
  let ghost: HTMLDivElement | null = null;

  const positionGhost = (x: number, y: number) => {
    if (!ghost) return;
    ghost.style.left = `${x + 12}px`;
    ghost.style.top = `${y + 12}px`;
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", onWindowBlur);
    document.body.classList.remove("oxide-dragging-file");
    ghost?.remove();
    ghost = null;
    if (activeCleanup === cancel) activeCleanup = null;
  };

  const cancel = () => {
    const wasActive = active;
    cleanup();
    if (wasActive) emit({ type: "cancel" });
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (!active) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD_PX) return;
      active = true;
      onStarted?.();
      document.body.classList.add("oxide-dragging-file");
      ghost = document.createElement("div");
      ghost.className = "file-drag-ghost";
      ghost.textContent = label;
      document.body.append(ghost);
    }
    positionGhost(event.clientX, event.clientY);
    emit({ type: "move", drag: { path, label, x: event.clientX, y: event.clientY } });
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    const wasActive = active;
    cleanup();
    if (wasActive) {
      emit({ type: "drop", drag: { path, label, x: event.clientX, y: event.clientY } });
    }
  };

  const onCancel = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    cancel();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  const onWindowBlur = () => {
    cancel();
  };

  activeCleanup = cancel;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("blur", onWindowBlur);
}
