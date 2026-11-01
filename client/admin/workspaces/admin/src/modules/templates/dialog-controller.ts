import { useCallback, useState } from "react";

export function useDisclosure(initialOpen = false) {
  const [open, setOpen] = useState(initialOpen);

  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);
  const onOpenChange = useCallback((next: boolean) => setOpen(next), []);

  return {
    open,
    openDialog,
    closeDialog,
    onOpenChange,
  };
}

export function useConfirmTarget<T>() {
  const [target, setTarget] = useState<T | null>(null);

  const request = useCallback((next: T) => setTarget(next), []);
  const clear = useCallback(() => setTarget(null), []);
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setTarget(null);
    }
  }, []);

  return {
    target,
    open: target !== null,
    request,
    clear,
    onOpenChange,
  };
}
