/** Share a callback's promise; the caller owns its stop order and failures. */
export function once(action: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return function close() {
    return (running ??= Promise.resolve().then(action));
  };
}
