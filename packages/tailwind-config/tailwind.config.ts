import type { Config } from 'tailwindcss/types/config';

// `nb-*` colors resolve to the --nb-* CSS tokens (side panel StepList.css, options Options.css),
// which flip with prefers-color-scheme, so no dark: variants are needed.
const nbTokens = [
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
];

export default {
  theme: {
    extend: {
      colors: {
        nb: Object.fromEntries(nbTokens.map(k => [k, `var(--nb-${k})`])),
      },
      boxShadow: { nb: 'var(--nb-glow)' },
    },
  },
  plugins: [],
} as Omit<Config, 'content'>;
