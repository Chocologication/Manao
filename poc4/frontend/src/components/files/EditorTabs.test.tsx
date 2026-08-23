import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorTabs } from './EditorTabs';

const tabs = [
  { path: 'pom.xml', title: 'pom.xml', isDirty: true },
  { path: 'src/main/App.java', title: 'App.java', isDirty: false },
];

describe('EditorTabs', () => {
  afterEach(() => {
    cleanup();
  });

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
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveAttribute('title', 'pom.xml');
    expect(screen.getByRole('tab', { name: /App.java/ })).toHaveAttribute(
      'title',
      'src/main/App.java',
    );
    await user.click(screen.getByRole('tab', { name: /App.java/ }));
    expect(onSelect).toHaveBeenCalledWith('src/main/App.java');
    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    expect(onClose).toHaveBeenCalledWith('pom.xml');
  });

  it('reveals the close button on keyboard focus-visible', () => {
    render(
      <EditorTabs
        tabs={tabs}
        activePath="src/main/App.java"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
      />,
    );

    const inactiveClose = screen.getByRole('button', { name: 'Close pom.xml' });
    expect(inactiveClose).toHaveClass('opacity-0');
    expect(inactiveClose).toHaveClass('focus-visible:opacity-100');
    expect(screen.getByRole('button', { name: 'Close App.java' })).toHaveClass(
      'focus-visible:opacity-100',
    );
  });

  it('renders a 32px Save command with an accessible name and focus ring', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditorTabs
        tabs={tabs}
        activePath="pom.xml"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
        onSave={onSave}
        saveDisabled={false}
        savePending={false}
      />,
    );

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('title', 'Save');
    expect(save).toHaveAttribute('aria-label', 'Save');
    expect(save).toHaveClass('size-8');
    expect(save).toHaveClass('focus-visible:ring-2');
    expect(save).toBeEnabled();
    expect(save.compareDocumentPosition(screen.getByRole('tablist'))).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
    await user.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('disables Save while clean or pending and shows a pending spinner', () => {
    const { rerender } = render(
      <EditorTabs
        tabs={tabs}
        activePath="pom.xml"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
        onSave={() => {}}
        saveDisabled
        savePending={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();

    rerender(
      <EditorTabs
        tabs={tabs}
        activePath="pom.xml"
        onSelect={() => {}}
        onClose={() => {}}
        onReorder={() => {}}
        onSave={() => {}}
        saveDisabled
        savePending
      />,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });
});
