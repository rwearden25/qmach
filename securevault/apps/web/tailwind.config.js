/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],

  theme: {
    screens: {
      mobile: '375px',
      tablet: '768px',
      desktop: '1024px',
      tv: '1920px',
    },

    extend: {
      colors: {
        background: '#0A0A0B',
        surface: '#141416',
        border: '#1F1F23',
        primary: '#00FF88',
        secondary: '#6366F1',
        danger: '#EF4444',
        warning: '#F59E0B',
        'text-primary': '#FAFAFA',
        'text-secondary': '#71717A',
      },

      borderRadius: {
        card: '12px',
        input: '8px',
        pill: '9999px',
      },

      fontFamily: {
        heading: ['"Cabinet Grotesk"', 'system-ui', 'sans-serif'],
        body: ['"General Sans"', 'system-ui', 'sans-serif'],
      },

      spacing: {
        'safe-tv': '5vw',
      },

      animation: {
        'skeleton-pulse': 'skeleton-pulse 1.5s ease-in-out infinite',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },

      keyframes: {
        'skeleton-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },

      boxShadow: {
        'glow-primary': '0 0 20px rgba(0, 255, 136, 0.25)',
        'glow-secondary': '0 0 20px rgba(99, 102, 241, 0.25)',
        card: '0 1px 3px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.6)',
      },
    },
  },

  plugins: [],
};
