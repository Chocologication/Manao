import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './AppErrorBoundary';

const SECRET_ERROR =
  'secret-stack JWT-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 password=demo-pass raw-body';

function Bomb(): ReactElement {
  throw new Error(SECRET_ERROR);
}

describe('AppErrorBoundary', () => {
  it('shows a full-page reload recovery view without leaking the thrown error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();

    const text = document.body.textContent ?? '';
    expect(text).not.toContain(SECRET_ERROR);
    expect(text).not.toContain('eyJhbGciOi');
    expect(text).not.toContain('demo-pass');
    expect(text).not.toContain('secret-stack');
    expect(text).not.toContain('raw-body');
  });
});
