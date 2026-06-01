import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  eslintPluginPrettier,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^$',
          varsIgnorePattern: '^$'
        }
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true }
      ]
    }
  },
  {
    // Lint only the TypeScript sources in tsconfig.eslint.json (src + test).
    // Everything else is outside the project, so the type-aware parser
    // (parserOptions.project) errors on it — which is what a repo-wide
    // `eslint .` (as CodeRabbit runs) hits on the root config files and the
    // hand-written .js config panel (bundled by webpack, not compiled by tsc,
    // and following its own JSX style). The lint script already globs only
    // src/test *.ts; ignore the rest here so the two stay consistent.
    ignores: [
      'plugin/**',
      'public/**',
      'node_modules/**',
      'src/configpanel/**/*.js',
      'build.js',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.ts'
    ]
  }
)
