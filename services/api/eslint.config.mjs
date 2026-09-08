import base from '../../eslint.config.base.mjs';

export default [
  ...base,
  {
    files: ['src/**/*.ts'],
    rules: {
      // MUST stay off for NestJS. A constructor parameter property like
      //   constructor(private readonly x: XService) {}
      // reads as type-only to ESLint, but `emitDecoratorMetadata` emits a real
      // runtime reference to XService for the DI container. Auto-fixing it to
      // `import type` erases that import and the app dies at boot with
      // "Nest can't resolve dependencies of ...". Do not turn this back on.
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
];
