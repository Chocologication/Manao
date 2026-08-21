export class ConnectionRegistry {
  private readonly closers = new Set<() => void>();

  register(close: () => void): () => void {
    this.closers.add(close);
    return () => {
      this.closers.delete(close);
    };
  }

  closeAll(): void {
    const closers = [...this.closers];
    this.closers.clear();
    for (const close of closers) {
      try {
        close();
      } catch {
        // 401 cleanup must still close every remaining connection.
      }
    }
  }
}
