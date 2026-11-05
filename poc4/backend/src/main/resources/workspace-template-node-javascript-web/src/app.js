import { createServer } from 'node:http';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';

async function checkDependencies() {
  if (process.env.MANAO_MYSQL_HOST) {
    const connection = await mysql.createConnection({
      host: process.env.MANAO_MYSQL_HOST, port: Number(process.env.MANAO_MYSQL_PORT ?? '3306'),
      user: process.env.MANAO_MYSQL_USERNAME, password: process.env.MANAO_MYSQL_PASSWORD,
      database: process.env.MANAO_MYSQL_DATABASE, connectTimeout: 1500,
    });
    try { await connection.query({ sql: 'SELECT 1', timeout: 1500 }); } finally { await connection.end(); }
  }
  if (process.env.MANAO_REDIS_HOST) {
    const client = createClient({ socket: { host: process.env.MANAO_REDIS_HOST,
      port: Number(process.env.MANAO_REDIS_PORT ?? '6379'), connectTimeout: 1500, reconnectStrategy: false },
      password: process.env.MANAO_REDIS_PASSWORD });
    client.on('error', () => {});
    try { await client.connect(); await client.ping(); } finally { if (client.isOpen) client.destroy(); }
  }
}

export function createApp(ready = checkDependencies) {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.url === '/health/ready') {
      try { await ready(); response.end(JSON.stringify({ status: 'ready' })); }
      catch { response.statusCode = 503; response.end(JSON.stringify({ status: 'unavailable' })); }
      return;
    }
    if (request.url === '/') { response.end(JSON.stringify({ message: 'Hello from Manao Node.js!' })); return; }
    response.statusCode = 404; response.end(JSON.stringify({ error: 'Not found' }));
  });
}
