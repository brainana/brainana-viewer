// ESLint flat config.
//
// SCOPE: deliberately narrow. `tsc --strict` already covers types; what it cannot see is the async
// misuse this codebase is most exposed to — a promise nobody awaits, an async callback handed to an
// API that ignores its return. Those are the bugs that show up here as a silently stale panel or an
// error that never reaches showError, and they are invisible to both the compiler and the tests.
//
// Rules are added when they earn their place. A large preset switched on at once would bury the
// handful of findings that matter under hundreds of style opinions, and the usual outcome of that
// is a blanket disable comment.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  {
    // Build output, dependencies, and packaged apps are not ours to lint.
    ignores: ['**/dist/**', '**/release/**', '**/node_modules/**', 'datasets/**', 'docs/**', 'packages/core-server/version.mjs'],
  },

  // --- Browser/TypeScript sources: type-aware, so the async rules actually work ---------------
  {
    files: ['apps/viewer/src/**/*.ts', 'packages/core-client/**/*.ts', 'packages/ui/**/*.ts', 'packages/niivue-kit/**/*.ts', 'packages/imaging-math/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, __APP_VERSION__: 'readonly' },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The reason this config exists.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',

      // tsc already reports unused locals/params (noUnusedLocals/noUnusedParameters); a second
      // opinion here would only produce duplicate output.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',

      // Style/idiom opinions from recommendedTypeChecked that this codebase deliberately does not
      // share. Off rather than individually suppressed, so nobody has to litter disable comments.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',

      // JSON.parse and NiiVue's untyped surface both yield `any`. The code already narrows those
      // deliberately, at documented boundaries; flagging every one of them would be noise that
      // trains people to stop reading lint output.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',

      // `String(value ?? '')` inside report/html.ts esc() is deliberate defensive stringification
      // of an `unknown`; "[object Object]" in a report beats throwing while building one.
      '@typescript-eslint/no-base-to-string': 'off',

      // Cosmetic: `unknown | null` does collapse to `unknown`, but the `| null` still tells a
      // reader the field is optional. Not worth editing types in an untested file to satisfy.
      '@typescript-eslint/no-redundant-type-constituents': 'off',

      // Fires on the `let x = <empty>; try { x = await … } catch { continue }` idiom, where the
      // initializer is required by TS and makes the fallback obvious. Fighting that pattern would
      // make the code worse, not safer.
      'no-useless-assignment': 'off',
    },
  },

  // --- Server .mjs: outside tsconfig, so type-aware rules cannot run here (audit finding X3) ---
  // Syntax-level checks only until that gap is closed; better than the nothing it had before.
  {
    files: ['packages/**/*.mjs', 'apps/**/*.mjs', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-useless-assignment': 'off', // same defensive-initializer idiom as the TS sources
    },
  },

  // --- Tests: node globals, and a bare `catch {}` is a legitimate assertion idiom here ---------
  {
    files: ['tests/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-useless-assignment': 'off',
      'no-empty': 'off',
    },
  },
)
