import { createApp } from './app.js';
const port = Number(process.env.MANAO_PRIMARY_PORT ?? process.env.PORT ?? process.env.SERVER_PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
const server = createApp();
server.listen(port, '0.0.0.0', () => console.log('Manao Node.js service is listening on port ' + port));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close(() => { process.exitCode = 0; });
  setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000).unref();
});
