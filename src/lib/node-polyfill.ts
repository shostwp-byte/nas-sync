import { AsyncLocalStorage } from 'node:async_hooks';

if (!(globalThis as Record<string, unknown>).AsyncLocalStorage) {
  (globalThis as Record<string, unknown>).AsyncLocalStorage = AsyncLocalStorage;
}

