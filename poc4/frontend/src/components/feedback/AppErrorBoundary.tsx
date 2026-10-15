import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Brand } from '@/components/ui/Brand';
import { CircleAlert, RefreshCw } from 'lucide-react';

export function ErrorRecoveryView() {
  return (
    <main className="lab-feedback-page">
      <Brand /><CircleAlert size={38} />
      <h1 className="text-lg font-medium">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">Reload the page to continue.</p>
      <Button type="button" onClick={() => window.location.reload()}>
        <RefreshCw />Reload
      </Button>
    </main>
  );
}

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(): void {
    // Recovery UI must not render the error, stack, token, or response body.
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorRecoveryView />;
    }
    return this.props.children;
  }
}
