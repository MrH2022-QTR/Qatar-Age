/**
 * The rules that matter here are the architectural ones, not the style ones.
 *
 * PORT_PLAN.md Phase 0 makes two commitments that are cheap to keep now and
 * expensive to retrofit later. Both are enforced mechanically rather than by
 * good intentions:
 *
 *   1. `src/sim/` must never import a renderer. That is what keeps the
 *      simulation headless — testable in Node, fuzzable at max speed, and
 *      serialisable for save/load.
 *   2. `src/sim/` must never call Math.random(). All randomness goes through
 *      the seeded PRNG in sim/random.ts, which keeps determinism reachable
 *      if we ever want lockstep multiplayer.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { browser: true, node: true, es2022: true },
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  overrides: [
    {
      files: ['src/sim/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              { group: ['pixi.js', 'pixi.js/*', '@render/*', '**/render/*'],
                message: 'src/sim must stay headless — no renderer imports. See PORT_PLAN.md Phase 0.' },
            ],
          },
        ],
        'no-restricted-properties': [
          'error',
          { object: 'Math', property: 'random',
            message: 'Use the seeded PRNG in sim/random.ts. See PORT_PLAN.md Phase 0.' },
        ],
        'no-restricted-globals': [
          'error',
          { name: 'requestAnimationFrame', message: 'src/sim must not depend on the browser frame loop.' },
        ],
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', '*.cjs'],
}
