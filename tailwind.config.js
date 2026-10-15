/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Restrained architectural palette: warm paper, cool graphite, one accent.
        paper: '#fbfaf9',
        surface: '#ffffff',
        line: '#e7e5e1',
        lineStrong: '#d6d3cd',
        ink: '#1c1b19',
        inkSoft: '#57534e',
        inkFaint: '#8a8580',
        accent: {
          DEFAULT: '#b4622d',
          soft: '#f3e7de',
          ink: '#8a4a20',
        },
        ok: '#3f7d58',
        warn: '#b5842b',
        danger: '#b3402f',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(28,27,25,0.04), 0 8px 24px -12px rgba(28,27,25,0.16)',
        pop: '0 2px 6px rgba(28,27,25,0.08), 0 16px 40px -16px rgba(28,27,25,0.28)',
      },
    },
  },
  plugins: [],
};