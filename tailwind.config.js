/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8',
          500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81', 950: '#1e1b4b',
        },
        accent: {
          50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9', 400: '#22d3ee',
          500: '#06b6d4', 600: '#0891b2', 700: '#0e7490', 800: '#155e75', 900: '#164e63', 950: '#083344',
        },
        ink: { 900: '#0b0b14' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: 0, transform: 'translateY(18px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
        floatSlow: {
          '0%, to': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-16px)' },
        },
        pop: {
          '0%': { opacity: 0, transform: 'scale(.92)' },
          to: { opacity: 1, transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-up': 'fadeUp .6s cubic-bezier(.16,1,.3,1) both',
        'float-slow': 'floatSlow 9s ease-in-out infinite',
        pop: 'pop .35s cubic-bezier(.34,1.56,.64,1) both',
        'spin-slow': 'spin 2.5s linear infinite',
      },
    },
  },
  plugins: [],
};
