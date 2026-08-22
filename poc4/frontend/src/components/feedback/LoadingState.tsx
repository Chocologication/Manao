export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      data-testid="loading-state"
      className="flex w-full flex-col gap-3"
    >
      <div className="h-24 w-full rounded-lg border bg-muted" />
      <div className="h-24 w-full rounded-lg border bg-muted" />
    </div>
  );
}
