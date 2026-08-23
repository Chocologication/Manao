import type { ProjectRelativePath } from '../../contracts/file';
import { parseProjectRelativePath } from '../files/pathPolicy';
import type { BufferSnapshot, WorkspaceBuffer } from './editorTypes';

export type { BufferSnapshot, WorkspaceBuffer };

export type WorkspaceBufferDirtyHandler = (
  projectId: string,
  path: ProjectRelativePath,
  dirty: boolean,
) => void;

export type WorkspaceTextModel = {
  getValue(): string;
  setValue(value: string): void;
  getAlternativeVersionId(): number;
  onDidChangeContent(listener: () => void): { dispose(): void };
  dispose(): void;
};

export type RegisterWorkspaceBufferInput =
  | {
      projectId: string;
      path: ProjectRelativePath;
      kind: 'monaco';
      model: WorkspaceTextModel;
    }
  | {
      projectId: string;
      path: ProjectRelativePath;
      kind: 'plain-text';
      content: string;
    };

function bufferKey(projectId: string, path: ProjectRelativePath): string {
  return `${projectId.length}:${projectId}:${path}`;
}

function isSelfOrDescendant(parent: ProjectRelativePath, candidate: ProjectRelativePath): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

type DirtySink = {
  emit(projectId: string, path: ProjectRelativePath, dirty: boolean): void;
};

abstract class BufferAdapter implements WorkspaceBuffer {
  readonly projectId: string;
  path: ProjectRelativePath;
  abstract readonly kind: 'monaco' | 'plain-text';
  private readonly listeners = new Set<() => void>();
  private readonly dirtySink: DirtySink;
  private lastDirty: boolean;
  protected disposed = false;

  constructor(projectId: string, path: ProjectRelativePath, dirtySink: DirtySink) {
    this.projectId = projectId;
    this.path = path;
    this.dirtySink = dirtySink;
    this.lastDirty = false;
  }

  abstract snapshot(): BufferSnapshot;
  abstract isDirty(): boolean;
  abstract markSaved(snapshot: BufferSnapshot): void;
  abstract discard(): void;
  protected abstract disposeResources(): void;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    try {
      this.snapshot();
    } catch {
      // Keep the last successful snapshot if the model is already gone.
    }
    this.disposed = true;
    try {
      this.disposeResources();
    } finally {
      this.listeners.clear();
      if (this.lastDirty) {
        this.lastDirty = false;
        this.dirtySink.emit(this.projectId, this.path, false);
      }
    }
  }

  protected notify(): void {
    const dirty = this.isDirty();
    if (dirty !== this.lastDirty) {
      this.lastDirty = dirty;
      this.dirtySink.emit(this.projectId, this.path, dirty);
    }
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class PlainTextBuffer extends BufferAdapter {
  readonly kind = 'plain-text' as const;
  private content: string;
  private epoch: number;
  private savedContent: string;
  private savedVersion: number;

  constructor(projectId: string, path: ProjectRelativePath, content: string, dirtySink: DirtySink) {
    super(projectId, path, dirtySink);
    this.content = content;
    this.epoch = 0;
    this.savedContent = content;
    this.savedVersion = 0;
  }

  snapshot(): BufferSnapshot {
    return { content: this.content, version: this.epoch };
  }

  isDirty(): boolean {
    return !this.disposed && this.epoch !== this.savedVersion;
  }

  markSaved(snapshot: BufferSnapshot): void {
    if (this.disposed) {
      return;
    }
    this.savedContent = snapshot.content;
    this.savedVersion = snapshot.version;
    this.notify();
  }

  discard(): void {
    if (this.disposed) {
      return;
    }
    this.content = this.savedContent;
    this.epoch = this.savedVersion;
    this.notify();
  }

  replace(content: string): void {
    if (this.disposed) {
      return;
    }
    this.content = content;
    this.epoch += 1;
    this.notify();
  }

  protected disposeResources(): void {}
}

class MonacoBuffer extends BufferAdapter {
  readonly kind = 'monaco' as const;
  private readonly model: WorkspaceTextModel;
  private savedContent: string;
  private savedVersion: number;
  private lastSnapshot: BufferSnapshot;
  private readonly contentListener: { dispose(): void };
  private restoring = false;

  constructor(
    projectId: string,
    path: ProjectRelativePath,
    model: WorkspaceTextModel,
    dirtySink: DirtySink,
  ) {
    super(projectId, path, dirtySink);
    this.model = model;
    this.savedContent = model.getValue();
    this.savedVersion = model.getAlternativeVersionId();
    this.lastSnapshot = { content: this.savedContent, version: this.savedVersion };
    this.contentListener = model.onDidChangeContent(() => {
      if (this.disposed || this.restoring) {
        return;
      }
      this.notify();
    });
  }

  snapshot(): BufferSnapshot {
    if (!this.disposed) {
      this.lastSnapshot = {
        content: this.model.getValue(),
        version: this.model.getAlternativeVersionId(),
      };
    }
    return { content: this.lastSnapshot.content, version: this.lastSnapshot.version };
  }

  isDirty(): boolean {
    return !this.disposed && this.model.getAlternativeVersionId() !== this.savedVersion;
  }

  markSaved(snapshot: BufferSnapshot): void {
    if (this.disposed) {
      return;
    }
    this.savedContent = snapshot.content;
    this.savedVersion = snapshot.version;
    this.notify();
  }

  discard(): void {
    if (this.disposed) {
      return;
    }
    this.restoring = true;
    try {
      this.model.setValue(this.savedContent);
      this.savedVersion = this.model.getAlternativeVersionId();
    } finally {
      this.restoring = false;
    }
    this.notify();
  }

  protected disposeResources(): void {
    this.contentListener.dispose();
    this.model.dispose();
  }
}

export class WorkspaceBufferRegistry {
  private readonly buffers = new Map<string, BufferAdapter>();
  private readonly onDirtyChange: WorkspaceBufferDirtyHandler;
  private readonly dirtySink: DirtySink;

  constructor(onDirtyChange: WorkspaceBufferDirtyHandler = () => {}) {
    this.onDirtyChange = onDirtyChange;
    this.dirtySink = {
      emit: (projectId, path, dirty) => {
        this.onDirtyChange(projectId, path, dirty);
      },
    };
  }

  get(projectId: string, path: ProjectRelativePath): WorkspaceBuffer | undefined {
    return this.buffers.get(bufferKey(projectId, parseProjectRelativePath(path)));
  }

  register(input: RegisterWorkspaceBufferInput): WorkspaceBuffer {
    const path = parseProjectRelativePath(input.path);
    const key = bufferKey(input.projectId, path);
    if (this.buffers.has(key)) {
      throw new Error('Workspace buffer already registered');
    }
    const buffer =
      input.kind === 'monaco'
        ? new MonacoBuffer(input.projectId, path, input.model, this.dirtySink)
        : new PlainTextBuffer(input.projectId, path, input.content, this.dirtySink);
    this.buffers.set(key, buffer);
    return buffer;
  }

  remap(projectId: string, from: ProjectRelativePath, to: ProjectRelativePath): void {
    parseProjectRelativePath(to);
    this.remove(projectId, from);
  }

  remove(projectId: string, path: ProjectRelativePath): void {
    const target = parseProjectRelativePath(path);
    for (const [key, buffer] of [...this.buffers]) {
      if (buffer.projectId === projectId && isSelfOrDescendant(target, buffer.path)) {
        this.buffers.delete(key);
        this.disposeBuffer(buffer);
      }
    }
  }

  disposeProject(projectId: string): void {
    for (const [key, buffer] of [...this.buffers]) {
      if (buffer.projectId === projectId) {
        this.buffers.delete(key);
        this.disposeBuffer(buffer);
      }
    }
  }

  disposeAll(): void {
    const buffers = [...this.buffers.values()];
    this.buffers.clear();
    for (const buffer of buffers) {
      this.disposeBuffer(buffer);
    }
  }

  private disposeBuffer(buffer: BufferAdapter): void {
    try {
      buffer.dispose();
    } catch {
      // 401 cleanup must still dispose every remaining workspace buffer.
    }
  }
}
