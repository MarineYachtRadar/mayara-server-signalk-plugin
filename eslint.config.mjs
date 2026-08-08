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
    // Test doubles are plain `vi.fn()` stubs on object literals, so referencing
    // one to assert on it (`vi.mocked(mock.whenReady)`) can never lose a `this`
    // binding — the rule's real target is methods on classes/prototypes. It
    // only started firing once signalk-container-helper's typed interfaces
    // replaced the loose local mirror.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off'
    }
  },
  {
    // The config panel is a browser bundle with its own tsconfig (DOM libs +
    // JSX, deliberately kept out of the Node compile), so the type-aware
    // parser needs to be pointed at that project for these files rather than
    // tsconfig.eslint.json — which does not include them.
    files: ['src/configpanel/**/*.ts', 'src/configpanel/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: './src/configpanel/tsconfig.json',
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    // Lint only the TypeScript sources in tsconfig.eslint.json (src + test)
    // plus the config panel (its own project, configured above). Everything
    // else is outside a TS project, so the type-aware parser errors on it —
    // which is what a repo-wide `eslint .` (as CodeRabbit runs) hits on the
    // root config files.
    ignores: [
      'plugin/**',
      'public/**',
      'node_modules/**',
      'build.js',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.ts'
    ]
  }
)
