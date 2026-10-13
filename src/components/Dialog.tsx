import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Open dialogs, innermost last. Keyboard handling is attached to the document
 * (not the modal element) so Escape and Tab still reach the dialog after the
 * focused control is removed from the page (focus then falls to <body>), and
 * only the innermost open dialog reacts, so one Escape never closes a stack.
 */
const openDialogs: symbol[] = [];

const FOCUSABLE =
  "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea,a[href]";

export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const element = ref.current!;
    const me = Symbol("dialog");
    openDialogs.push(me);
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.querySelector<HTMLElement>("button,input,select")?.focus();
    const handle = (event: KeyboardEvent) => {
      // Only the innermost dialog handles keys; others stay silent.
      if (openDialogs[openDialogs.length - 1] !== me) return;
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key === "Tab") {
        const focusable = Array.from(
          element.querySelectorAll<HTMLElement>(FOCUSABLE),
        );
        const first = focusable[0],
          last = focusable.at(-1);
        const active = document.activeElement;
        if (!element.contains(active)) {
          // Focus was lost (for example the focused control was removed):
          // bring it back inside instead of tabbing through the page.
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      const index = openDialogs.indexOf(me);
      if (index >= 0) openDialogs.splice(index, 1);
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide-modal" : ""}`}
      >
        <button className="close" aria-label="Close" onClick={onClose}>
          <X />
        </button>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
