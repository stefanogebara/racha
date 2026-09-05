'use strict';

/**
 * Jest owns the Node side (`api/`), and only that.
 *
 * The diner PWA's split math lives in TypeScript (`apps/web/src/split.ts`) and
 * is tested by `node --test` instead — Node 22 strips the types natively, so
 * that suite costs zero build config and zero new dependencies. Without this
 * ignore, jest discovers `split.test.ts` and dies in babel with a parse error
 * on the first type annotation.
 *
 * Both run under `npm test`.
 */
module.exports = {
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/apps/', '/ios/'],
};
