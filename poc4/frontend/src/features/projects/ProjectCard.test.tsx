import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ProjectCard } from './ProjectCard';
import type { ProjectSummary } from '../../contracts/project';

const ready: ProjectSummary = {
  id: 'prj/a?b#c',
  name: 'Opaque',
  state: 'READY',
  createdAt: '2026-08-21T00:00:00.000Z',
  failureReason: null,
};

describe('ProjectCard', () => {
  it('encodes opaque project ids in the open link', () => {
    render(
      <MemoryRouter>
        <ProjectCard project={ready} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      `/projects/${encodeURIComponent(ready.id)}`,
    );
  });
});
