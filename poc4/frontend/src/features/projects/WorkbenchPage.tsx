import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { workspaceBufferRegistry } from '@/app/appRuntime';
import { WorkbenchShell } from '@/components/shell/WorkbenchShell';
import type { ProjectSummary } from '@/contracts/project';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { fileKeys } from '@/features/files/fileQueries';
import { disposeProjectModels } from '@/lib/projectMonacoModels';

export function WorkbenchPage({ project }: { project: ProjectSummary }) {
  const queryClient = useQueryClient();
  const projectId = project.id;

  useEffect(() => {
    const previousId = useWorkspaceSession.getState().projectId;
    if (previousId !== null && previousId !== projectId) {
      const queryKey = fileKeys.all(previousId);
      void queryClient.cancelQueries({ queryKey });
      workspaceBufferRegistry.disposeProject(previousId);
      disposeProjectModels(previousId);
      useWorkspaceSession.getState().reset();
      queryClient.removeQueries({ queryKey });
    }
    useWorkspaceSession.getState().activateProject(projectId);
  }, [projectId, queryClient]);

  return <WorkbenchShell key={project.id} project={project} />;
}

export default WorkbenchPage;
