import { Link } from 'react-router';
import { InlineAlert } from './InlineAlert';
import { ShieldAlert } from 'lucide-react';

export function AccessDeniedPage() {
  return (
    <div className="lab-access-denied">
      <ShieldAlert size={30} />
      <InlineAlert>Access denied</InlineAlert>
      <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
        Back to projects
      </Link>
    </div>
  );
}
