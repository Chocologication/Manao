import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { subscribeToThemeChanges } from '../features/preferences/themePreferences';
import { AppErrorBoundary } from '../components/feedback/AppErrorBoundary';
import { AuthProvider } from '../features/auth/AuthProvider';
import { authSession, queryClient } from './appRuntime';
import { subscribeToMotionChanges } from '@/features/preferences/motionPreferences';

export function AppProviders({ children }: { children: ReactNode }) {
  useEffect(subscribeToThemeChanges, []);
  useEffect(subscribeToMotionChanges, []);
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider session={authSession}>{children}</AuthProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
