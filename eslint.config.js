import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // #303: type-aware rules need the compiler project, and only `src/` is in
    // tsconfig.json. The rest of the tree (scripts, the client package, the
    // examples, the config files) is linted with the non-type-checked set
    // above, so widening the target (#305) does not force type information
    // onto code that has no project to resolve it.
    files: ['src/**/*.ts'],
    ignores: ['src/__tests__/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A forgotten `await` in the indexer silently drops a write.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // GitHub Actions scripts (actions/github-script loads CommonJS).
    files: ['.github/scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Node scripts, config files and examples run outside `src/` and reach for
    // the runtime globals; ESLint's `no-undef` only knows them when declared.
    files: ['scripts/**/*.{ts,mts,mjs}', '*.ts', '*.mjs', 'test/**/*.ts', 'test/**/*.mts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
  {
    rules: {
      // Unused arguments are fine when prefixed, e.g. Fastify handlers.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
