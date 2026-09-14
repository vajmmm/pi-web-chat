import { Dialog } from "@base-ui-components/react/dialog";
import { SessionsPanel } from "./SessionsDrawer";

/**
 * Mobile sessions drawer dialog. Kept in its own module so the eager app shell
 * only pays for the trigger button, not `@base-ui-components/react/dialog`.
 */
export function SessionsDrawerDialog({
  open,
  onOpenChange,
  hidePortal,
  currentSessionFile,
  onSelectSession,
  onClose,
  onDock,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hidePortal: boolean;
  currentSessionFile?: string;
  onSelectSession: () => void;
  onClose: () => void;
  onDock: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {!hidePortal && (
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
          <Dialog.Popup className="fixed inset-y-0 left-0 flex w-[82vw] max-w-xs flex-col bg-sidebar shadow-2xl outline-none transition-transform data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full">
            <SessionsPanel
              currentSessionFile={currentSessionFile}
              active={open}
              title={
                <Dialog.Title className="font-mono text-sm font-black tracking-widest text-ink">
                  PI // CHAT
                </Dialog.Title>
              }
              onSelectSession={onSelectSession}
              onClose={onClose}
              onDock={onDock}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}
