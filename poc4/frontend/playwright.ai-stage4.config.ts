import { defineConfig } from '@playwright/test';
import base from './playwright.ai-terminal-settlement.config';
export default defineConfig({ ...base, testMatch: 'ai-stage4.spec.ts', outputDir: 'test-results/ai-stage4' });
