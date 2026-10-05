import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended'

export default defineConfig(
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
    // Everything outside a TS project would make the type-aware parser error,
    // which is what a repo-wide `eslint .` (as CodeRabbit runs) hits. What is
    // left after these is TypeScript in tsconfig.eslint.json (src, test and
    // the root tooling) or in the config panel's own project above.
    ignores: ['plugin/**', 'public/**', 'node_modules/**']
  }
)
