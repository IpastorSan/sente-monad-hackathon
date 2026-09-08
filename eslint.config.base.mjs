// Shared flat-config base for every workspace package.
//
// IMPORTANT: `files` patterns in a flat config resolve relative to the
// directory of the config file ESLint actually loaded — which, because each
// package has its own `eslint.config.mjs`, is the PACKAGE directory, not the
// repo root. So this file must contain only path-agnostic config. Anything
// package-specific belongs in that package's own config, where the relative
// paths mean what you think they mean.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** Directories no package should ever lint. */
export const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.expo/**',
  '**/ios/**',
  '**/android/**',
  '**/*.d.ts',
];

export default tseslint.config(
  { ignores },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // CommonJS config files (metro.config.js, jest.config.js, ...).
    files: ['**/*.cjs', '**/*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
