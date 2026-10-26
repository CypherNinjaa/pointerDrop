/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        space: '#050508',
        cyan: { warp: '#0A84FF', ice: '#64D2FF' },
        lime: { signal: '#30D158' },
        amber: { system: '#FF9F0A' },
        danger: '#FF453A',
        glass: {
          surface: 'rgba(28, 28, 30, 0.65)',
          edge: 'rgba(255, 255, 255, 0.15)',
        },
        ink: {
          primary: 'rgba(255, 255, 255, 0.94)',
          secondary: 'rgba(235, 235, 245, 0.68)',
          tertiary: 'rgba(235, 235, 245, 0.45)',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Segoe UI Variable"', '"Segoe UI"', 'Inter', 'sans-serif'],
        mono: ['"SF Mono"', 'ui-monospace', '"Cascadia Code"', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        glass: '24px',
      },
      transitionTimingFunction: {
        'out-strong': 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out-strong': 'cubic-bezier(0.77, 0, 0.175, 1)',
        drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
    },
  },
  plugins: [],
};
