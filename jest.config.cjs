/** @type {import('jest').Config} */
// Self-contained test config. The only non-obvious part is how `@open-mercato/*`
// value imports are made loadable, so that is documented precisely — the
// widely-copied workaround for this is wrong, and wrong in a way that looks
// right.
//
// The problem: `@open-mercato/*` is published ESM-only ("type": "module", no
// `require` condition in its exports map). This package imports one *value*
// from it (`extractSearchableFields` in lib/driver.ts), so the test runtime has
// to cope with real ESM. Type-only imports are erased at compile time and never
// hit this, which is why the issue stays invisible until the first value import.
//
// What works — and it is just the one line below: let the exports map resolve
// the specifier to the package's published `dist/*.js`, then let ts-jest
// transform that ESM to CommonJS like any other source file. `.js` files go
// through the transform pipeline normally.
//
// What does NOT work, despite appearing in a sibling package's config: adding
// `moduleNameMapper` to redirect `@open-mercato/*` at the dependency's `src/*.ts`.
// Verified 2026-08-08 across two repos and both 0.6.6 and 0.6.7 — Jest treats a
// `.ts` file whose nearest package.json says `"type": "module"` as natively
// loadable ESM and BYPASSES the transform entirely, so the file arrives with its
// types stripped by Node and its `export` keywords intact and the CJS runtime
// dies on `SyntaxError: Unexpected token 'export'`. Emptying
// `transformIgnorePatterns` does not help, because transformation was never the
// gate. The mapper is not a fix for this problem; it is the cause of it.
//
// `passWithNoTests` is deliberately absent — an empty run is a failure.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],

  // Jest skips node_modules for transformation by default. @open-mercato/* must
  // opt in, because its published output is ESM that needs converting to CJS.
  transformIgnorePatterns: ['node_modules/(?!@open-mercato/)'],

  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        diagnostics: { ignoreCodes: [151001] },
        tsconfig: {
          module: 'commonjs',
          // `bundler`, not `node`: it resolves package `exports` maps, which is
          // exactly the mechanism relied on above to reach dist/*.js. Legacy
          // `node` resolution predates exports maps and fails with TS2307 on
          // subpaths like `@open-mercato/search/fulltext`.
          moduleResolution: 'bundler',
          target: 'ES2022',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          verbatimModuleSyntax: false,
          skipLibCheck: true,
        },
      },
    ],
  },

  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.(ts|tsx)'],
}
