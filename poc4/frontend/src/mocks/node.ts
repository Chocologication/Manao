import { setupServer } from 'msw/node';
import { handlers } from './handlers';
import { runLogsSocketHandler } from './runSocket';
import { terminalSocketHandler } from './terminalSocket';

export const server = setupServer(...handlers, runLogsSocketHandler, terminalSocketHandler);
