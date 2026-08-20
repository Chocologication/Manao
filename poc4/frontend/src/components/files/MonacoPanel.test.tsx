import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as monacoModels from '@/lib/monacoModels';
import { toModelUri } from '@/lib/monacoModels';
import { MonacoPanel } from './MonacoPanel';

describe('MonacoPanel', () => {
  it('disposes a closed active tab only after the editor path has switched', async () => {
    const user = userEvent.setup();
    const pathWhenDispose = new Map<string, string>();
    vi.spyOn(monacoModels, 'disposeModel').mockImplementation((path: string) => {
      pathWhenDispose.set(
        path,
        screen.queryByTestId('mock-editor')?.getAttribute('data-path') ?? ''
      );
    });

    render(<MonacoPanel />);

    expect(screen.getByTestId('mock-editor')).toHaveAttribute(
      'data-path',
      toModelUri('pom.xml').toString()
    );

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));

    await waitFor(() => {
      expect(monacoModels.disposeModel).toHaveBeenCalledWith('pom.xml');
    });

    expect(pathWhenDispose.get('pom.xml')).toBe(
      toModelUri('src/main/java/demo/App.java').toString()
    );
  });
});
