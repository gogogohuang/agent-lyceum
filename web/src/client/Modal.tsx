import { useEffect, useId, useRef, type ReactNode } from "react";

/** A native <dialog>: the browser traps focus, closes on Esc and puts focus back on the button that opened it. */
export function Modal({
  open,
  title,
  onClose,
  closable = true,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** When false, Esc is blocked (the native `cancel` event is prevented). The caller must also disable its own close buttons. */
  closable?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const openRef = useRef(open);
  openRef.current = open;
  const closableRef = useRef(closable);
  closableRef.current = closable;
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
      onCancel={(e) => {
        if (!closable) e.preventDefault();
      }}
      // Also fires after a parent-driven close(); only report a close the parent has not already made.
      onClose={(e) => {
        if (!openRef.current) return;
        if (!closableRef.current) {
          // The browser closed us anyway (e.g. a second Esc can't be cancelled): reopen instead of unmounting mid-request.
          const dialog = e.currentTarget;
          if (!dialog.open) dialog.showModal();
          return;
        }
        onClose();
      }}
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
