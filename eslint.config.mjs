import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules', '**/.next', '**/.open-next', '**/.wrangler', '**/dist', '**/*.d.ts'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] } },
);
