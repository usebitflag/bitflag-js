import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { loadRelease } from './tests/support/node-release.js';

// The conformance suite in a real browser, where engine differences show up. The browser cannot read files, so a
// command run in Node hands it the extracted protocol release.
export default defineConfig({
  test: {
    include: ['tests/browser/**/*.browser.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
      commands: {
        loadRelease: () => Object.fromEntries(loadRelease()),
      },
    },
  },
});
