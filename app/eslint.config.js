/*
 * Krakatoa — one lint rule, and it earns its keep.
 *
 * `rules-of-hooks` is here because it caught a real crash the day it went in:
 * `FoodView` called a `useMemo` BELOW an early return, so the hook count changed
 * the moment the store hydrated and React blanked the entire app with a minified
 * #310. No render test can see that — server rendering runs each component once
 * with a fresh instance, so both branches render perfectly on their own. Only a
 * static check finds it, which is exactly Bushido's lesson about `.filter(fn)`
 * blanking that app: a whole-app crash from a line that reads fine.
 *
 * Deliberately NOT a general style config. Formatting opinions cost more than
 * they return on a one-person app; this is a correctness gate.
 */
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
]
