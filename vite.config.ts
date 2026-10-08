import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Only these modules are provided by the Wealthfolio addon sandbox at runtime
 * (see HOST_DEPENDENCIES in @wealthfolio/addon-sdk). Everything else must be
 * bundled so the package is self-contained.
 *
 * Keep this list minimal: every external is a runtime dependency that can only
 * be resolved by the host. Bundling `react` would break hooks, because the host
 * renderer owns the dispatcher. `@wealthfolio/ui` and `recharts` are external so the
 * addon renders with the host's design tokens and chart theme instead of a bundled
 * copy that could drift from the application's styling.
 */
const HOST_EXTERNALS = [
  'react',
  'react-dom',
  '@wealthfolio/addon-sdk',
  '@wealthfolio/ui',
  '@wealthfolio/ui/chart',
  '@wealthfolio/ui/styles',
  'recharts',
];

export default defineConfig({
  plugins: [
    // Classic JSX runtime on purpose: it keeps the emitted module imports to
    // `react` only, avoiding a `react/jsx-runtime` external that older hosts
    // do not always expose to the sandbox.
    react({ jsxRuntime: 'classic' }),
  ],
  esbuild: {
    jsx: 'transform',
  },
  // The sandbox has no `process`; guard any dependency that references it.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry: 'src/addon.tsx',
      formats: ['es'],
      fileName: () => 'addon.js',
    },
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    sourcemap: true,
    minify: 'esbuild',
    rollupOptions: {
      external: HOST_EXTERNALS,
      output: {
        // The host loads addon CSS from `dist/`; keep a predictable name instead
        // of Vite's default `style.css`.
        assetFileNames: (asset) =>
          asset.names?.some((name) => name.endsWith('.css'))
            ? 'addon.css'
            : '[name][extname]',
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          '@wealthfolio/addon-sdk': 'WealthfolioAddonSDK',
        },
      },
    },
  },
});
