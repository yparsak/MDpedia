import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'backups/', 'app/public/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
];
