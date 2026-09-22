import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
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
  afterEach(() => {
    cleanup();
  });

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

  it('renders deleting status without an open action', () => {
    const deleting: ProjectSummary = {
      ...ready,
      state: 'DELETING',
      name: 'Deleting project',
    };
    render(
      <MemoryRouter>
        <ProjectCard project={deleting} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Deleting')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('shows the non-sensitive runtime configuration when present', () => {
    const configured: ProjectSummary = {
      ...ready,
      name: 'Configured',
      runtime: {
        templateId: 'java-spring-boot-web',
        mysql: true,
        redis: false,
        publicPorts: [{ name: 'port-1', targetPort: 8080, publicPort: 30081 }],
      },
      endpointState: 'UNKNOWN',
    };
    render(
      <MemoryRouter>
        <ProjectCard project={configured} />
      </MemoryRouter>,
    );

    const runtime = screen.getByText(/Spring Boot web/);
    expect(runtime).toHaveTextContent('MySQL');
    expect(runtime).not.toHaveTextContent('Redis');
    expect(runtime).toHaveTextContent('8080→30081');
    expect(screen.getByText('Public endpoint unconfirmed')).toBeInTheDocument();
    expect(screen.queryByText(/MySQL READY/)).not.toBeInTheDocument();
  });

  it('shows live dependency readiness and the assigned public endpoint', () => {
    const assigned: ProjectSummary = {
      ...ready,
      name: 'Assigned',
      runtime: {
        templateId: 'java-spring-boot-web',
        mysql: true,
        redis: false,
        publicPorts: [{ name: 'port-1', targetPort: 8080, publicPort: 30081 }],
      },
      endpointState: 'ASSIGNED',
      dependencies: { mysql: 'READY', redis: 'ABSENT' },
      endpoints: [
        { name: 'port-1', targetPort: 8080, publicPort: 30081, url: 'http://entry.example:30081' },
      ],
    };
    render(
      <MemoryRouter>
        <ProjectCard project={assigned} />
      </MemoryRouter>,
    );

    expect(screen.getByText('MySQL READY')).toBeInTheDocument();
    expect(screen.queryByText('Redis ABSENT')).not.toBeInTheDocument();
    expect(screen.getByText('30081: http://entry.example:30081')).toBeInTheDocument();
    expect(screen.queryByText('Public endpoint unconfirmed')).not.toBeInTheDocument();
  });

  it('shows no runtime line for legacy summaries without runtime fields', () => {
    render(
      <MemoryRouter>
        <ProjectCard project={ready} />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Spring Boot web/)).not.toBeInTheDocument();
    expect(screen.queryByText('Public endpoint unconfirmed')).not.toBeInTheDocument();
  });
});
