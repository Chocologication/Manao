import http from 'node:http';
import { WebSocketServer } from 'ws';

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  response.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/terminal') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client));
});

wss.on('connection', (client) => {
  client.send(JSON.stringify({ type: 'terminal.ready', sessionId: crypto.randomUUID() }));
  client.send(new TextEncoder().encode('\u001b[32mPOC4 browser terminal ready\u001b[0m\r\n'));
  client.on('message', (data, isBinary) => {
    if (isBinary) client.send(data, { binary: true });
    else if (JSON.parse(data.toString()).type === 'terminal.close') client.close(1000);
  });
});

server.listen(4174, '127.0.0.1');

function shutdown() {
  for (const client of wss.clients) client.terminate();
  wss.close(() => server.close(() => process.exit(0)));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
