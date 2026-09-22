import { useState, type FormEvent } from 'react';
import { ApiRequestError } from '../../api/ApiRequestError';
import type {
  CreateProjectRequest,
  ProjectPublicPort,
  RuntimeTemplateId,
} from '../../contracts/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { useCheckProjectCreation, useCreateProject } from './projectQueries';

const NAME_MAX = 64;
const MAX_PUBLIC_PORTS = 3;
const TEMPLATES: ReadonlyArray<{ value: RuntimeTemplateId; label: string }> = [
  { value: 'java-console', label: 'Java console' },
  { value: 'java-spring-boot-web', label: 'Java Spring Boot web' },
];

type PortRow = { targetPort: string; publicPort: string };

function newRow(): PortRow {
  return { targetPort: '8080', publicPort: '' };
}

function isPort(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
}

/**
 * Parses the rows exactly as entered. An empty public port is invalid instead of
 * substituted, so the request keeps the original values or the submission is blocked.
 */
function parsePortRows(rows: readonly PortRow[]): ProjectPublicPort[] | null {
  const seenPublicPorts = new Set<number>();
  const ports: ProjectPublicPort[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isPort(row.targetPort, 1, 65535) || !isPort(row.publicPort, 30000, 31000)) {
      return null;
    }
    const publicPort = Number(row.publicPort);
    if (seenPublicPorts.has(publicPort)) {
      return null;
    }
    seenPublicPorts.add(publicPort);
    ports.push({ name: `port-${index + 1}`, targetPort: Number(row.targetPort), publicPort });
  }
  return ports;
}

/**
 * RFC 4122 v4 creation key. crypto.randomUUID only exists in secure contexts
 * (HTTPS or localhost), and the accepted deployment serves plain HTTP on a public
 * IP, so generation falls back to crypto.getRandomValues - which insecure origins
 * provide too - instead of throwing before the request is ever sent.
 */
function newCreationKey(): string {
  const cryptoRef = globalThis.crypto;
  if (typeof cryptoRef?.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoRef?.getRandomValues === 'function') {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function describeSubmitted(request: CreateProjectRequest): string {
  const parts: string[] = [];
  if (request.templateId !== undefined) {
    parts.push(request.templateId);
  }
  if (request.mysql === true) {
    parts.push('MySQL');
  }
  if (request.redis === true) {
    parts.push('Redis');
  }
  for (const port of request.publicPorts ?? []) {
    parts.push(`port ${port.targetPort} → public ${port.publicPort}`);
  }
  return `Created ${request.name} · ${parts.join(' · ')}`;
}

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && /network request failed/i.test(error.message);
}

export function CreateProjectForm({
  locked,
  limitReached,
}: {
  locked: boolean;
  limitReached: boolean;
}) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<RuntimeTemplateId>('java-console');
  const [mysql, setMysql] = useState(false);
  const [redis, setRedis] = useState(false);
  const [publicAccess, setPublicAccess] = useState(false);
  const [portRows, setPortRows] = useState<PortRow[]>([newRow()]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // The key of the last unresolved attempt; a lost response keeps it so an explicit
  // retry continues the same creation instead of silently starting a new one.
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const create = useCreateProject();
  const check = useCheckProjectCreation();

  const trimmed = name.trim();
  const nameValid = trimmed.length >= 1 && trimmed.length <= NAME_MAX;
  const portsActive = template === 'java-spring-boot-web' && publicAccess;
  const parsedPorts = portsActive ? parsePortRows(portRows) : [];
  const submitDisabled =
    locked ||
    limitReached ||
    !nameValid ||
    create.isPending ||
    check.isPending ||
    (portsActive && parsedPorts === null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitDisabled || parsedPorts === null) {
      return;
    }
    const creationKey = pendingKey ?? newCreationKey();
    // The key is fixed before sending so a lost response keeps querying the same creation.
    setPendingKey(creationKey);
    // Dependency selections exist only with the web template: a switch back to the console
    // template masks the hidden flags instead of submitting configuration nobody sees.
    const webTemplate = template === 'java-spring-boot-web';
    const request: CreateProjectRequest = {
      name: trimmed,
      creationKey,
      templateId: template,
      mysql: webTemplate && mysql,
      redis: webTemplate && redis,
      publicPorts: parsedPorts,
    };
    setError(null);
    setSuccess(null);
    try {
      await create.mutateAsync(request);
      setPendingKey(null);
      setAwaitingConfirmation(false);
      // The submitted original values stay visible in the result status; the inputs reset
      // so a second creation starts clean instead of resubmitting the same form.
      setName('');
      setSuccess(describeSubmitted(request));
    } catch (reason) {
      if (reason instanceof ApiRequestError) {
        if (reason.body?.code === 'PROJECT_LIMIT_REACHED') {
          setError('Project limit reached');
          setPendingKey(null);
          setAwaitingConfirmation(false);
          return;
        }
        if (reason.body?.code === 'PUBLIC_ENDPOINT_UNCONFIRMED') {
          setError('Creation result is not confirmed. Check the creation status before retrying.');
          setAwaitingConfirmation(true);
          return;
        }
        setError(reason.body?.message ?? 'Unable to create project');
        setPendingKey(null);
        setAwaitingConfirmation(false);
        return;
      }
      if (isNetworkError(reason)) {
        setError('Network request failed');
        setAwaitingConfirmation(true);
        return;
      }
      setError('Unable to create project');
      setPendingKey(null);
      setAwaitingConfirmation(false);
    }
  }

  async function onCheckCreation(): Promise<void> {
    if (pendingKey === null || check.isPending) {
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      const project = await check.mutateAsync(pendingKey);
      setPendingKey(null);
      setAwaitingConfirmation(false);
      setName('');
      setSuccess(`Created ${project.name}`);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.body?.code === 'ENTRY_NOT_FOUND') {
        setError(
          'Creation is not confirmed yet. The same request can be submitted again with the same key.',
        );
        return;
      }
      setError(isNetworkError(reason) ? 'Network request failed' : 'Unable to check the creation status');
    }
  }

  function updateRow(index: number, update: Partial<PortRow>): void {
    setPortRows((rows) => rows.map((row, current) => (current === index ? { ...row, ...update } : row)));
  }

  function clearFeedback(): void {
    if (error) {
      setError(null);
    }
    if (success) {
      setSuccess(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <form className="flex flex-wrap items-end gap-2" onSubmit={onSubmit}>
        <div className="w-80 max-w-full">
          <label htmlFor="project-name" className="mb-1 block text-sm">
            Project name
          </label>
          <Input
            id="project-name"
            name="project-name"
            value={name}
            maxLength={NAME_MAX}
            disabled={locked || limitReached || create.isPending}
            onChange={(event) => {
              setName(event.target.value);
              clearFeedback();
            }}
          />
        </div>
        <div className="w-56 max-w-full">
          <label htmlFor="project-template" className="mb-1 block text-sm">
            Template
          </label>
          <select
            id="project-template"
            aria-label="Template"
            className="h-9 w-full rounded-lg border border-input bg-background px-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64 sm:h-8 sm:text-sm"
            value={template}
            disabled={locked || limitReached || create.isPending}
            onChange={(event) => {
              setTemplate(event.target.value as RuntimeTemplateId);
              clearFeedback();
            }}
          >
            {TEMPLATES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        {template === 'java-spring-boot-web' ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="project-public-access" className="flex items-center gap-2 text-sm">
              <input
                id="project-public-access"
                type="checkbox"
                checked={publicAccess}
                disabled={locked || limitReached || create.isPending}
                onChange={(event) => {
                  setPublicAccess(event.target.checked);
                  clearFeedback();
                }}
              />
              Public access
            </label>
            <label htmlFor="project-mysql" className="flex items-center gap-2 text-sm">
              <input
                id="project-mysql"
                type="checkbox"
                checked={mysql}
                disabled={locked || limitReached || create.isPending}
                onChange={(event) => {
                  setMysql(event.target.checked);
                  clearFeedback();
                }}
              />
              MySQL
            </label>
            <label htmlFor="project-redis" className="flex items-center gap-2 text-sm">
              <input
                id="project-redis"
                type="checkbox"
                checked={redis}
                disabled={locked || limitReached || create.isPending}
                onChange={(event) => {
                  setRedis(event.target.checked);
                  clearFeedback();
                }}
              />
              Redis
            </label>
          </div>
        ) : null}
        <Button type="submit" disabled={submitDisabled}>
          Create project
        </Button>
      </form>
      {portsActive ? (
        <div className="flex flex-col gap-2">
          {portRows.map((row, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="w-40 max-w-full">
                <label htmlFor={`container-port-${index + 1}`} className="mb-1 block text-sm">
                  Container port {index + 1}
                </label>
                <Input
                  id={`container-port-${index + 1}`}
                  type="number"
                  value={row.targetPort}
                  min={1}
                  max={65535}
                  disabled={locked || limitReached || create.isPending}
                  onChange={(event) => {
                    updateRow(index, { targetPort: event.target.value });
                    clearFeedback();
                  }}
                />
              </div>
              <div className="w-40 max-w-full">
                <label htmlFor={`public-port-${index + 1}`} className="mb-1 block text-sm">
                  Public port {index + 1}
                </label>
                <Input
                  id={`public-port-${index + 1}`}
                  type="number"
                  value={row.publicPort}
                  placeholder="30000-31000"
                  min={30000}
                  max={31000}
                  disabled={locked || limitReached || create.isPending}
                  onChange={(event) => {
                    updateRow(index, { publicPort: event.target.value });
                    clearFeedback();
                  }}
                />
              </div>
            </div>
          ))}
          {portRows.length < MAX_PUBLIC_PORTS ? (
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={locked || limitReached || create.isPending}
                onClick={() => {
                  setPortRows((rows) => [...rows, newRow()]);
                  clearFeedback();
                }}
              >
                Add port
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {limitReached ? (
        <p className="text-sm text-muted-foreground">Project limit reached</p>
      ) : (
        <p className="text-sm text-muted-foreground">1–64 characters. Display name only.</p>
      )}
      {success ? (
        <p role="status" aria-label="Create result" className="text-sm">
          {success}
        </p>
      ) : null}
      {awaitingConfirmation && pendingKey !== null ? (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={check.isPending}
            onClick={() => void onCheckCreation()}
          >
            Check creation status
          </Button>
        </div>
      ) : null}
      {error ? <InlineAlert>{error}</InlineAlert> : null}
    </div>
  );
}
