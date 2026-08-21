import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider } from '../features/auth/AuthProvider';
import { authSession, queryClient } from './appRuntime';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider session={authSession}>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
