declare module 'vitest/browser' {
  interface BrowserCommands {
    /** The extracted protocol release: file path relative to its root to the text of the file. */
    loadRelease: () => Promise<Record<string, string>>;
  }
}

export {};
