export class WorkspaceResourceRegistry {
  private readonly disposers = new Set<() => void>();

  register(dispose: () => void): () => void {
    this.disposers.add(dispose);
    return () => {
      this.disposers.delete(dispose);
    };
  }

  disposeAll(): void {
    const disposers = [...this.disposers];
    this.disposers.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 401 cleanup must still dispose every remaining workspace resource.
      }
    }
  }
}
