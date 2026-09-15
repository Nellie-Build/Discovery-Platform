/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f1f5fb',
          100: '#dde7f5',
          200: '#bccfea',
          300: '#93b1da',
          400: '#6890c6',
          500: '#4672ad',
          600: '#345990',
          700: '#2b4874',
          800: '#263c60',
          900: '#233451',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
