/** Show the error text only when the entry is in dev mode. */
export function ErrorDetails({ error, dev }: { error: unknown; dev: boolean }) {
  const detail = dev ? (error instanceof Error ? error.message : String(error)) : undefined;

  return (
    <main>
      <h1>Something went wrong</h1>
      {detail !== undefined && <pre>{detail}</pre>}
    </main>
  );
}
