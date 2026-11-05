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

    expect(screen.getByRole('link', { name: '进入工作台' })).toHaveAttribute(
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
    expect(screen.getByText('正在删除')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '进入工作台' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '进入工作台' })).not.toBeInTheDocument();
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

    const runtime = screen.getByText(/Spring Boot 网站/);
    expect(runtime).toHaveTextContent('MySQL');
    expect(runtime).not.toHaveTextContent('Redis');
    expect(runtime).toHaveTextContent('8080→30081');
    expect(screen.getByText('外部访问地址尚未确认')).toBeInTheDocument();
    expect(screen.queryByText(/MySQL 已就绪/)).not.toBeInTheDocument();
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

    expect(screen.getByText('MySQL 已就绪')).toBeInTheDocument();
    expect(screen.queryByText('Redis 未启用')).not.toBeInTheDocument();
    expect(screen.getByText('30081: http://entry.example:30081')).toBeInTheDocument();
    expect(screen.queryByText('外部访问地址尚未确认')).not.toBeInTheDocument();
  });

  it('shows no runtime line for legacy summaries without runtime fields', () => {
    render(
      <MemoryRouter>
        <ProjectCard project={ready} />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Spring Boot 网站/)).not.toBeInTheDocument();
    expect(screen.queryByText('外部访问地址尚未确认')).not.toBeInTheDocument();
  });

  it('shows python templates with their accurate language and shape', () => {
    const pythonConsole: ProjectSummary = {
      ...ready,
      name: 'Py Console',
      runtime: { templateId: 'python-console', mysql: false, redis: false, publicPorts: [] },
    };
    render(
      <MemoryRouter>
        <ProjectCard project={pythonConsole} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Python 控制台')).toBeInTheDocument();

    cleanup();
    const fastApi: ProjectSummary = {
      ...ready,
      name: 'Py Web',
      runtime: {
        templateId: 'python-fastapi-web',
        mysql: true,
        redis: false,
        publicPorts: [{ name: 'port-1', targetPort: 8000, publicPort: 30082 }],
      },
    };
    render(
      <MemoryRouter>
        <ProjectCard project={fastApi} />
      </MemoryRouter>,
    );
    const runtime = screen.getByText(/Python FastAPI 网站/);
    expect(runtime).toHaveTextContent('MySQL');
    expect(runtime).toHaveTextContent('8000→30082');
  });

  it('links to the status page for a failed python dependency reconciliation', () => {
    const failed: ProjectSummary = {
      ...ready,
      name: 'Py Reconciliation',
      state: 'FAILED',
      failureReason: 'WORKSPACE_RECONCILIATION_REQUIRED',
      runtime: { templateId: 'python-fastapi-web', mysql: false, redis: false, publicPorts: [] },
    };
    render(
      <MemoryRouter>
        <ProjectCard project={failed} />
      </MemoryRouter>,
    );

    // The recovery entry is a dedicated link into the status page; Open stays closed for FAILED.
    const link = screen.getByRole('link', { name: '查看依赖更新状态' });
    expect(link).toHaveAttribute('href', `/projects/${encodeURIComponent(failed.id)}`);
    expect(screen.queryByRole('link', { name: '进入工作台' })).not.toBeInTheDocument();
  });

  it('offers no dependency recovery entry for other failures or non-python runtimes', () => {
    const otherReason: ProjectSummary = {
      ...ready,
      name: 'Py Other Failure',
      state: 'FAILED',
      failureReason: 'Mock workspace provisioning failed',
      runtime: { templateId: 'python-console', mysql: false, redis: false, publicPorts: [] },
    };
    render(
      <MemoryRouter>
        <ProjectCard project={otherReason} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: '查看依赖更新状态' })).not.toBeInTheDocument();

    cleanup();
    const java: ProjectSummary = {
      ...ready,
      name: 'Java Reconciliation',
      state: 'FAILED',
      failureReason: 'WORKSPACE_RECONCILIATION_REQUIRED',
      runtime: { templateId: 'java-spring-boot-web', mysql: false, redis: false, publicPorts: [] },
    };
    render(
      <MemoryRouter>
        <ProjectCard project={java} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: '查看依赖更新状态' })).not.toBeInTheDocument();

    cleanup();
    const deleting: ProjectSummary = {
      ...ready,
      name: 'Py Deleting',
      state: 'DELETING',
      failureReason: 'WORKSPACE_RECONCILIATION_REQUIRED',
      runtime: { templateId: 'python-console', mysql: false, redis: false, publicPorts: [] },
    };
    render(
      <MemoryRouter>
        <ProjectCard project={deleting} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: '查看依赖更新状态' })).not.toBeInTheDocument();
  });
});
