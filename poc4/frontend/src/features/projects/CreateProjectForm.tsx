import { useState, type FormEvent } from 'react';
import { ApiRequestError } from '../../api/ApiRequestError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { useCreateProject } from './projectQueries';

const NAME_MAX = 64;

export function CreateProjectForm({
  locked,
  limitReached,
}: {
  locked: boolean;
  limitReached: boolean;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateProject();
  const trimmed = name.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= NAME_MAX;
  const submitDisabled = locked || limitReached || !valid || create.isPending;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (locked || limitReached || !valid || create.isPending) {
      return;
    }
    setError(null);
    try {
      await create.mutateAsync({ name: trimmed });
      setName('');
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.body?.code === 'PROJECT_LIMIT_REACHED') {
        setError('Project limit reached');
      } else if (reason instanceof Error && /network request failed/i.test(reason.message)) {
        setError('Network request failed');
      } else {
        setError('Unable to create project');
      }
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
              if (error) {
                setError(null);
              }
            }}
          />
        </div>
        <Button type="submit" disabled={submitDisabled}>
          Create project
        </Button>
      </form>
      {limitReached ? (
        <p className="text-sm text-muted-foreground">Project limit reached</p>
      ) : (
        <p className="text-sm text-muted-foreground">1–64 characters. Display name only.</p>
      )}
      {error ? <InlineAlert>{error}</InlineAlert> : null}
    </div>
  );
}
