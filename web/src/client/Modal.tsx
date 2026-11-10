import { useEffect, useId, useRef, type ReactNode } from "react";

/** A native <dialog>: the browser traps focus, closes on Esc and puts focus back on the button that opened it. */
export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(38rem,calc(100vw-2rem))] max-h-[90dvh] overflow-y-auto rounded-xl border border-line bg-paper p-0 text-ink backdrop:bg-black/40"
    >
      {open && (
        <div className="p-4 sm:p-6">
          <h2 id={titleId} className="text-balance text-xl font-semibold tracking-tight">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
