import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditorTabs } from './EditorTabs';

const tabs = [
  { path: 'pom.xml', title: 'pom.xml', isDirty: true },
  { path: 'src/main/App.java', title: 'App.java', isDirty: false },
];

describe('EditorTabs', () => {
  it('shows dirty state and emits relative paths', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <EditorTabs
        tabs={tabs}
        activePath="pom.xml"
        onSelect={onSelect}
        onClose={onClose}
        onReorder={() => {}}
      />
    );

    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    await user.click(screen.getByRole('tab', { name: /App.java/ }));
    expect(onSelect).toHaveBeenCalledWith('src/main/App.java');
    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    expect(onClose).toHaveBeenCalledWith('pom.xml');
  });
});
