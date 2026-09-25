import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login } from '../../api/authApi';
import { authSession } from '../../app/appRuntime';
import { server } from '../../mocks/node';
import { renderApp, resetAppRuntime } from '../../test/renderApp';

const ALICE = { username: 'alice', password: 'demo-pass' };

type PostBody = {
  name?: unknown;
  creationKey?: unknown;
  templateId?: unknown;
  mysql?: unknown;
  redis?: unknown;
  publicPorts?: unknown;
};

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

function createdSummary(name: string) {
  return {
    id: 'prj-created',
    name,
    state: 'CREATING',
    createdAt: new Date().toISOString(),
    failureReason: null,
  };
}

async function fillWebForm(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await screen.findByRole('article', { name: 'Alice Notebook' });
  await user.type(screen.getByLabelText('Project name'), name);
  await user.selectOptions(screen.getByLabelText('Template'), 'java-spring-boot-web');
  await user.click(screen.getByLabelText('Public access'));
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  resetAppRuntime();
});

describe('CreateProjectForm port rows', () => {
  it('keeps the entered public port after conflict', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/v1/projects', () => HttpResponse.json({
      code: 'PUBLIC_PORT_IN_USE', message: 'Public port is unavailable. Choose another port.',
      traceId: '00000000-0000-4000-8000-000000000001',
    }, { status: 409 })));
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await fillWebForm(user, 'demo');
    await user.clear(screen.getByLabelText('Container port 1'));
    await user.type(screen.getByLabelText('Container port 1'), '8080');
    await user.type(screen.getByLabelText('Public port 1'), '30081');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Public port is unavailable. Choose another port.')).toBeVisible();
    expect(screen.getByLabelText('Public port 1')).toHaveValue(30081);
    expect(screen.getByLabelText('Container port 1')).toHaveValue(8080);
    expect(screen.getByLabelText('Project name')).toHaveValue('demo');
  });

  it('blocks submission while a public port row is empty', async () => {
    const user = userEvent.setup();
    const bodies: PostBody[] = [];
    server.use(
      http.post('/api/v1/projects', async ({ request }) => {
        bodies.push((await request.json()) as PostBody);
        return HttpResponse.json(createdSummary('demo'), { status: 201 });
      }),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await fillWebForm(user, 'demo');

    const submit = screen.getByRole('button', { name: 'Create project' });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(bodies).toHaveLength(0);

    await user.type(screen.getByLabelText('Public port 1'), '30081');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]?.publicPorts).toEqual([
      { name: 'port-1', targetPort: 8080, publicPort: 30081 },
    ]);
  });

  it('submits an empty public port list when public access is off', async () => {
    const user = userEvent.setup();
    const bodies: PostBody[] = [];
    server.use(
      http.post('/api/v1/projects', async ({ request }) => {
        bodies.push((await request.json()) as PostBody);
        return HttpResponse.json(createdSummary('demo'), { status: 201 });
      }),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await fillWebForm(user, 'demo');
    await user.type(screen.getByLabelText('Public port 1'), '30081');
    await user.click(screen.getByLabelText('Public access'));
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]?.publicPorts).toEqual([]);
    expect(bodies[0]?.templateId).toBe('java-spring-boot-web');
  });

  it('submits no dependencies after switching back to the console template', async () => {
    const user = userEvent.setup();
    const bodies: PostBody[] = [];
    server.use(
      http.post('/api/v1/projects', async ({ request }) => {
        bodies.push((await request.json()) as PostBody);
        return HttpResponse.json(createdSummary('demo'), { status: 201 });
      }),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await fillWebForm(user, 'demo');
    await user.click(screen.getByLabelText('MySQL'));
    await user.click(screen.getByLabelText('Redis'));
    // The dependency checkboxes disappear with the web template; the hidden state
    // must not leak into the console request the user now sends.
    await user.selectOptions(screen.getByLabelText('Template'), 'java-console');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({
      templateId: 'java-console',
      mysql: false,
      redis: false,
      publicPorts: [],
    });
  });

  it('submits every port row verbatim including target port 80 and 18081', async () => {
    const user = userEvent.setup();
    const bodies: PostBody[] = [];
    server.use(
      http.post('/api/v1/projects', async ({ request }) => {
        bodies.push((await request.json()) as PostBody);
        return HttpResponse.json(createdSummary('demo'), { status: 201 });
      }),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await fillWebForm(user, 'demo');
    await user.clear(screen.getByLabelText('Container port 1'));
    await user.type(screen.getByLabelText('Container port 1'), '80');
    await user.type(screen.getByLabelText('Public port 1'), '30081');
    await user.click(screen.getByRole('button', { name: 'Add port' }));
    await user.clear(screen.getByLabelText('Container port 2'));
    await user.type(screen.getByLabelText('Container port 2'), '18081');
    await user.type(screen.getByLabelText('Public port 2'), '30082');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({
      name: 'demo',
      templateId: 'java-spring-boot-web',
      mysql: false,
      redis: false,
      publicPorts: [
        { name: 'port-1', targetPort: 80, publicPort: 30081 },
        { name: 'port-2', targetPort: 18081, publicPort: 30082 },
      ],
    });
    expect(typeof bodies[0]?.creationKey).toBe('string');
  });

  it('shows the submitted original values after success and clears the name', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/v1/projects', () =>
        HttpResponse.json(createdSummary('demo'), { status: 201 })),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await fillWebForm(user, 'demo');
    await user.click(screen.getByLabelText('MySQL'));
    await user.type(screen.getByLabelText('Public port 1'), '30081');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    const status = await screen.findByRole('status', { name: 'Create result' });
    expect(status).toHaveTextContent('Created demo');
    expect(status).toHaveTextContent('java-spring-boot-web');
    expect(status).toHaveTextContent('MySQL');
    expect(status).toHaveTextContent('30081');
    expect(screen.getByLabelText('Project name')).toHaveValue('');
  });
});

describe('CreateProjectForm creation key', () => {
  it('keeps the same creation key after a lost response and only queries that key', async () => {
    const user = userEvent.setup();
    const bodies: PostBody[] = [];
    const creationLookups: string[] = [];
    server.use(
      http.post('/api/v1/projects', async ({ request }) => {
        bodies.push((await request.json()) as PostBody);
        return HttpResponse.error();
      }),
      http.get('/api/v1/projects/creation/:creationKey', ({ params }) => {
        creationLookups.push(String(params.creationKey));
        return HttpResponse.json(
          {
            code: 'ENTRY_NOT_FOUND',
            message: 'Project not found',
            traceId: 'trace-creation-missing',
          },
          { status: 404 },
        );
      }),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await fillWebForm(user, 'demo');
    await user.type(screen.getByLabelText('Public port 1'), '30081');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Network request failed')).toBeVisible();
    expect(bodies).toHaveLength(1);
    const firstKey = bodies[0]?.creationKey;
    expect(typeof firstKey).toBe('string');

    await user.click(screen.getByRole('button', { name: 'Check creation status' }));
    expect(await screen.findByText(/not confirmed yet/i)).toBeVisible();
    expect(creationLookups).toEqual([firstKey]);

    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]?.creationKey).toBe(firstKey);
  });

  it('keeps the inputs and the creation key when the preflight is unavailable', async () => {
    // A 503 PUBLIC_PORT_PREFLIGHT_UNAVAILABLE means the cluster pre-check itself could not
    // run: the port is neither occupied nor free, nothing was created, so the form keeps
    // every input and the retry reuses the same creation key.
    const user = userEvent.setup();
    const bodies: PostBody[] = [];
    server.use(
      http.post('/api/v1/projects', async ({ request }) => {
        bodies.push((await request.json()) as PostBody);
        return HttpResponse.json(
          {
            code: 'PUBLIC_PORT_PREFLIGHT_UNAVAILABLE',
            message: 'Public port availability cannot be verified right now. Try again later.',
            traceId: 'trace-preflight-unknown',
          },
          { status: 503 },
        );
      }),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await fillWebForm(user, 'demo');
    await user.type(screen.getByLabelText('Public port 1'), '30081');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText(/cannot be verified right now/i)).toBeVisible();
    expect(screen.getByLabelText('Project name')).toHaveValue('demo');
    expect(screen.getByLabelText('Public port 1')).toHaveValue(30081);

    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]?.creationKey).toBe(bodies[0]?.creationKey);
  });

  it('uses a new creation key after a deterministic rejection', async () => {
    const user = userEvent.setup();
    const bodies: PostBody[] = [];
    let attempts = 0;
    server.use(
      http.post('/api/v1/projects', async ({ request }) => {
        bodies.push((await request.json()) as PostBody);
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(
            {
              code: 'PUBLIC_PORT_IN_USE',
              message: 'Public port is unavailable. Choose another port.',
              traceId: 'trace-port-conflict',
            },
            { status: 409 },
          );
        }
        return HttpResponse.json(createdSummary('demo'), { status: 201 });
      }),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await fillWebForm(user, 'demo');
    await user.type(screen.getByLabelText('Public port 1'), '30081');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(
      await screen.findByText('Public port is unavailable. Choose another port.'),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]?.creationKey).not.toBe(bodies[0]?.creationKey);
    expect(await screen.findByRole('status', { name: 'Create result' })).toHaveTextContent(
      'Created demo',
    );
  });

  it('confirms a lost creation through the same key and resets the form', async () => {
    const user = userEvent.setup();
    const bodies: PostBody[] = [];
    const creationLookups: string[] = [];
    const created = { ...createdSummary('demo'), runtime: null, failureReason: null };
    let responseLost = false;
    server.use(
      http.post('/api/v1/projects', async ({ request }) => {
        responseLost = true;
        bodies.push((await request.json()) as PostBody);
        return HttpResponse.error();
      }),
      http.get('/api/v1/projects/creation/:creationKey', ({ params }) => {
        creationLookups.push(String(params.creationKey));
        return HttpResponse.json(created);
      }),
      http.get('/api/v1/projects', () =>
        HttpResponse.json({ items: responseLost ? [created] : [], limit: 8 })),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: ['/projects'] });
    await screen.findByText(/no projects yet/i);
    await user.type(screen.getByLabelText('Project name'), 'demo');
    await user.selectOptions(screen.getByLabelText('Template'), 'java-spring-boot-web');
    await user.click(screen.getByLabelText('Public access'));
    await user.type(screen.getByLabelText('Public port 1'), '30081');
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Network request failed')).toBeVisible();
    const firstKey = bodies[0]?.creationKey;

    // The same creation key confirms the project that the lost response had actually created.
    await user.click(screen.getByRole('button', { name: 'Check creation status' }));
    expect(await screen.findByRole('status', { name: 'Create result' })).toHaveTextContent(
      'Created demo',
    );
    expect(creationLookups).toEqual([firstKey]);
    expect(await screen.findByRole('article', { name: 'demo' })).toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Check creation status' })).toBeNull();
  });

  it('still creates a project when crypto.randomUUID is unavailable (insecure HTTP origin)', async () => {
    // The accepted deployment serves plain HTTP on a public IP: crypto.randomUUID only
    // exists in secure contexts, so creation must not depend on it (regression 2026-09-22:
    // the submit handler threw before sending the request and no status was ever shown).
    const originalRandomUUID = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    try {
      const user = userEvent.setup();
      const bodies: PostBody[] = [];
      server.use(
        http.post('/api/v1/projects', async ({ request }) => {
          bodies.push((await request.json()) as PostBody);
          return HttpResponse.json(createdSummary('demo'), { status: 201 });
        }),
      );
      await authenticateAsAlice();
      renderApp({ initialEntries: ['/projects'] });
      await fillWebForm(user, 'demo');
      await user.type(screen.getByLabelText('Public port 1'), '30081');
      await user.click(screen.getByRole('button', { name: 'Create project' }));
      expect(await screen.findByRole('status', { name: 'Create result' })).toHaveTextContent(
        'Created demo',
      );
      expect(bodies).toHaveLength(1);
      expect(typeof bodies[0]?.creationKey).toBe('string');
      expect(bodies[0]?.creationKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: originalRandomUUID,
        configurable: true,
      });
    }
  });
});
