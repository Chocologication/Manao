import { constants, closeSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'coverage', 'target']);
const REPORT_BEGIN = 'MANAO-SUREFIRE-REPORT-BEGIN';
const REPORT_END = 'MANAO-SUREFIRE-REPORT-END';
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;

/** Bound reads and refuse links even if an entry changes after directory enumeration. */
function readRegular(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('File is not regular or exceeds the size limit');
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new Error('File exceeds the size limit');
    return bytes;
  } finally { closeSync(fd); }
}

/** Application runs execute a private copy, keeping generated files out of the workspace. */
export function copyProject(source, destination) {
  let files = 0, bytes = 0;
  const copy = (directory, target) => {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name) || entry.name.startsWith('.manao')) continue;
      const path = join(directory, entry.name), output = join(target, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Source symbolic links are not supported');
      if (stat.isDirectory()) { copy(path, output); continue; }
      if (++files > 1000) throw new Error('Source exceeds the 1000 file limit');
      const data = readRegular(path, MAX_SOURCE_BYTES - bytes); bytes += data.length;
      writeFileSync(output, data, { flag: 'wx' });
    }
  };
  copy(source, destination);
  return { files, bytes };
}

export function initializeStore(cache, seed) {
  mkdirSync(cache, { recursive: true });
  const store = join(cache, 'store');
  if (existsSync(store)) {
    if (!lstatSync(store).isDirectory() || lstatSync(store).isSymbolicLink()) throw new Error('Invalid package cache');
    return store;
  }
  // Publish only a complete seed; interrupted copies never masquerade as a usable store.
  const staging = mkdtempSync(join(cache, '.seed-'));
  if (seed && existsSync(seed)) cpSync(seed, staging, { recursive: true, dereference: false });
  renameSync(staging, store);
  return store;
}

export async function execute(program, args, { cwd, env = process.env, signal, stdio = 'inherit' }) {
  if (signal?.aborted) return 143;
  return new Promise((resolveExit, reject) => {
    const child = spawn(program, args, { cwd, env, stdio, detached: process.platform !== 'win32', windowsHide: true });
    let killTimer;
    const stop = () => {
      if (process.platform === 'win32') {
        // Windows has no process groups; stop pnpm and its application together.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => child.kill('SIGKILL'));
        return;
      }
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); }
      catch { child.kill('SIGTERM'); }
      killTimer = setTimeout(() => {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      }, 5000); killTimer.unref();
    };
    signal?.addEventListener('abort', stop, { once: true });
    const finish = () => { clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { finish(); reject(error); });
    child.once('close', (code, killedBy) => { finish(); resolveExit(code ?? (killedBy ? 143 : 1)); });
    if (signal?.aborted) stop();
  });
}

function attachReports(workspace, output) {
  output(REPORT_BEGIN);
  try {
    const path = join(workspace, '.manao-test-results.xml');
    if (lstatSync(path).isSymbolicLink()) throw new Error('Report link refused');
    output(readRegular(path, MAX_REPORT_BYTES).toString('utf8'));
    output(REPORT_END + ' truncated=0 files=1 state=ok');
  } catch {
    output(REPORT_END + ' truncated=0 files=0 state=missing');
  }
}

export async function runProject({ mode, goal, workspace = '/workspace', cache = '/node-cache',
  seed = '/opt/manao-node-seed/store', pnpm = '/usr/local/bin/pnpm', signal, output = console.log,
  executeCommand = execute, temporaryRoot = tmpdir(), env = process.env }) {
  if (!['console', 'web', 'build'].includes(mode) || mode === 'build' && !['compile', 'test', 'package'].includes(goal)) {
    throw new Error('Expected console, web, or build <compile|test|package>');
  }
  if (mode === 'web' && (!/^\d+$/.test(env.MANAO_PRIMARY_PORT ?? '') || Number(env.MANAO_PRIMARY_PORT) < 1 || Number(env.MANAO_PRIMARY_PORT) > 65535)) {
    throw new Error('Web mode requires the server-provided primary port');
  }
  let cwd = workspace, temporary;
  if (mode !== 'build') {
    temporary = mkdtempSync(join(temporaryRoot, 'manao-node-'));
    cwd = join(temporary, 'project');
  }
  try {
    if (temporary) {
      copyProject(workspace, cwd);
    }
    const pkg = JSON.parse(readRegular(join(cwd, 'package.json'), 128 * 1024).toString('utf8'));
    if (pkg.packageManager !== 'pnpm@10.33.0') throw new Error('Project must use pnpm@10.33.0');
    const scripts = ['build', ...(mode === 'build' ? goal === 'test' ? ['test'] : [] : ['start'])];
    for (const script of scripts) {
      if (typeof pkg.scripts?.[script] !== 'string' || !pkg.scripts[script].trim()) throw new Error('Required project script is missing: ' + script);
    }
    readRegular(join(cwd, 'pnpm-lock.yaml'), 2 * 1024 * 1024);
    const store = initializeStore(cache, seed);
    const run = args => executeCommand(pnpm, args, { cwd, env, signal });
    output('正在准备 Node.js 项目依赖…');
    let code = await run(['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts', '--store-dir', store,
      '--config.manage-package-manager-versions=false', '--config.package-manager-strict=true']);
    if (code !== 0) return code;
    code = await run(['run', 'build']);
    if (code !== 0 || signal?.aborted) return signal?.aborted ? 143 : code;
    if (mode === 'build') {
      if (goal === 'test') { code = await run(['run', 'test']); attachReports(cwd, output); }
      if (goal === 'package') code = await run(['pack', '--pack-destination', mkdtempSync(join(temporaryRoot, 'manao-node-package-'))]);
      return code;
    }
    return await run(['run', 'start']);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
  try {
    const [mode, goal, ...extra] = process.argv.slice(2);
    if (extra.length || (mode !== 'build' && goal !== undefined)) throw new Error('Unexpected launcher arguments');
    process.exitCode = await runProject({ mode, goal, signal: controller.signal });
  } catch (error) {
    console.error('manao-node: ' + (error instanceof Error ? error.message : 'Execution failed'));
    process.exitCode = 1;
  }
}
