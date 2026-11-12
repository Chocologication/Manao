import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './app.js';

test('serves the application and readiness endpoint', async () => {
  const server = createApp(async () => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  const base = 'http://127.0.0.1:' + address.port;
  try {
    const root = await fetch(base + '/'); assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { message: 'Hello from Manao Node.js!' });
    assert.equal((await fetch(base + '/health/ready')).status, 200);
    assert.equal((await fetch(base + '/missing')).status, 404);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
});

test('reports dependency failures without exposing credentials', async () => {
  const server = createApp(async () => { throw new Error('private connection details'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port');
  try {
    const response = await fetch('http://127.0.0.1:' + address.port + '/health/ready');
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: 'unavailable' });
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
});
