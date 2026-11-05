import { copyProject } from './runner.mjs';

try {
  copyProject('/source', '/workspace');
} catch (error) {
  console.error('manao-node copy: ' + (error instanceof Error ? error.message : 'Copy failed'));
  process.exitCode = 1;
}
