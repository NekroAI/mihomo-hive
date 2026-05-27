import React from "react";

export interface ConfirmAction {
  title: string;
  description: string;
  detail?: React.ReactNode;
  confirmLabel: string;
  dangerous?: boolean;
  run: () => Promise<void>;
}

export interface ConfirmActionController {
  current: ConfirmAction | undefined;
  request: (action: ConfirmAction) => void;
  cancel: () => void;
  resolve: () => Promise<void>;
}

export function useConfirmAction(): ConfirmActionController {
  const [current, setCurrent] = React.useState<ConfirmAction | undefined>();

  const request = React.useCallback((action: ConfirmAction) => {
    setCurrent(action);
  }, []);

  const cancel = React.useCallback(() => {
    setCurrent(undefined);
  }, []);

  const resolve = React.useCallback(async () => {
    const action = current;
    if (!action) {
      return;
    }
    setCurrent(undefined);
    await action.run();
  }, [current]);

  return { current, request, cancel, resolve };
}
