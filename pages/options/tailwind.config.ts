import baseConfig from '@extension/tailwindcss-config';
import { withUI } from '@extension/ui';

// `nb-*` colors resolve to the CSS tokens in src/Options.css, which flip with prefers-color-scheme.
const nb = (name: string) => `var(--nb-${name})`;

export default withUI({
  ...baseConfig,
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        nb: Object.fromEntries(
          [
            'page',
            'tile',
            'tile-2',
            'line',
            'hair',
            'ink',
            'ink-2',
            'muted',
            'track',
            'llm',
            'jev',
            'plan',
            'good',
            'warning',
            'critical',
          ].map(k => [k, nb(k)]),
        ),
      },
      boxShadow: { nb: 'var(--nb-glow)' },
    },
  },
});
