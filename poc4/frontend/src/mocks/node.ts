import { setupServer } from 'msw/node';
import { handlers } from './handlers';
import { runLogsSocketHandler } from './runSocket';

export const server = setupServer(...handlers, runLogsSocketHandler);
