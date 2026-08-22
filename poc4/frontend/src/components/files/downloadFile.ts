import { downloadFileBlob } from '../../api/fileApi';
import type { ProjectRelativePath } from '../../contracts/file';

export async function downloadFile(
  projectId: string,
  path: ProjectRelativePath,
  fallbackName: string,
): Promise<void> {
  const { blob, filename } = await downloadFileBlob(projectId, path, fallbackName);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    try {
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
