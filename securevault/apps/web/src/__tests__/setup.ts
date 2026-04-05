/**
 * Vitest / jsdom global test setup
 *
 * This file is run once before each test file (configured via vitest
 * setupFiles).  It:
 *
 *   1. Imports @testing-library/jest-dom so all custom matchers
 *      (toBeInTheDocument, toHaveTextContent, etc.) are available globally.
 *
 *   2. Polyfills the Web Crypto API (crypto.subtle) if the jsdom environment
 *      does not expose it.  Node 19+ exposes globalThis.crypto natively; for
 *      older Node versions this falls back to Node's built-in webcrypto.
 *
 *      If you need a more complete browser-compatible polyfill (e.g. for
 *      algorithms not in Node's webcrypto), install @peculiar/webcrypto:
 *
 *          npm install -D @peculiar/webcrypto
 *
 *      Then replace the crypto polyfill block below with:
 *
 *          import { Crypto } from "@peculiar/webcrypto";
 *          if (!globalThis.crypto?.subtle) {
 *            Object.defineProperty(globalThis, "crypto", {
 *              value: new Crypto(),
 *              writable: false,
 *            });
 *          }
 *
 *   3. Polyfills IntersectionObserver and ResizeObserver (jsdom does not
 *      implement either, but many UI components depend on them).
 *
 *   4. Polyfills window.matchMedia (jsdom stubs are no-ops; components that
 *      call matchMedia for responsive behaviour need the stub to be callable).
 *
 *   5. Silences expected React 18 act() warnings in the test output.
 */

// ─── 1. jest-dom custom matchers ─────────────────────────────────────────────

import "@testing-library/jest-dom";

// ─── 2. Web Crypto API polyfill ───────────────────────────────────────────────

// Node 15+ exposes `globalThis.crypto` via the `node:crypto` WebCrypto module.
// jsdom does not forward it into the window object, so we inject it manually.
if (!globalThis.crypto?.subtle) {
  // Prefer the native Node webcrypto; fall back gracefully if unavailable.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { webcrypto } = require("node:crypto") as {
      webcrypto: Crypto;
    };
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      configurable: true,
      writable: false,
    });
  } catch {
    console.warn(
      "[test/setup] Could not polyfill Web Crypto API. " +
        "Consider installing @peculiar/webcrypto for full browser-API compatibility."
    );
  }
}

// Also ensure window.crypto mirrors globalThis.crypto in jsdom context
if (typeof window !== "undefined" && !window.crypto?.subtle && globalThis.crypto?.subtle) {
  Object.defineProperty(window, "crypto", {
    value: globalThis.crypto,
    configurable: true,
    writable: false,
  });
}

// ─── 3. IntersectionObserver mock ────────────────────────────────────────────

if (typeof window !== "undefined" && !("IntersectionObserver" in window)) {
  class MockIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = "0px";
    readonly thresholds: ReadonlyArray<number> = [];

    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn((): IntersectionObserverEntry[] => []);
  }

  Object.defineProperty(window, "IntersectionObserver", {
    writable: true,
    configurable: true,
    value: MockIntersectionObserver,
  });

  Object.defineProperty(global, "IntersectionObserver", {
    writable: true,
    configurable: true,
    value: MockIntersectionObserver,
  });
}

// ─── 4. ResizeObserver mock ───────────────────────────────────────────────────

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  class MockResizeObserver implements ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }

  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: MockResizeObserver,
  });

  Object.defineProperty(global, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: MockResizeObserver,
  });
}

// ─── 5. window.matchMedia stub ────────────────────────────────────────────────

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),    // deprecated but still called by some libs
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ─── 6. Suppress React act() console warnings in tests ───────────────────────

const originalError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const firstArg = args[0];
  if (
    typeof firstArg === "string" &&
    (firstArg.includes("not wrapped in act") ||
      firstArg.includes("Warning: An update to"))
  ) {
    return;
  }
  originalError(...args);
};
