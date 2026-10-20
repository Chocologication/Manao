import { Link } from 'react-router';
import { SearchX } from 'lucide-react';
import { Brand } from '@/components/ui/Brand';

export function NotFoundPage() {
  return (
    <main className="lab-feedback-page">
      <Brand /><SearchX size={38} />
      <h1 className="text-lg font-medium">Not found</h1>
      <p className="text-sm text-muted-foreground">This page does not exist.</p>
      <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
        Back to projects
      </Link>
    </main>
  );
}
