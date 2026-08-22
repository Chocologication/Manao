import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="flex min-h-full flex-col items-start gap-4 bg-background px-6 py-5 text-foreground">
      <h1 className="text-lg font-medium">Not found</h1>
      <p className="text-sm text-muted-foreground">This page does not exist.</p>
      <Link to="/projects" className="text-sm text-foreground underline-offset-4 hover:underline">
        Back to projects
      </Link>
    </main>
  );
}
