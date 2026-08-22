import { Link } from 'react-router';
import { InlineAlert } from './InlineAlert';

export function AccessDeniedPage() {
  return (
    <div className="flex flex-col items-start gap-2">
      <InlineAlert>Access denied</InlineAlert>
      <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
        Back to projects
      </Link>
    </div>
  );
}
