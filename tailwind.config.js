/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./*.html",
    "./netlify/functions/*.js",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
  // Keep these safelist classes that are built dynamically via JS template literals
  safelist: [
    // Status colors used in JS
    { pattern: /bg-(red|green|yellow|blue|indigo|orange|gray|purple|pink)-(50|100|200|300|400|500|600|700|800|900)/ },
    { pattern: /text-(red|green|yellow|blue|indigo|orange|gray|purple|pink)-(50|100|200|300|400|500|600|700|800|900)/ },
    { pattern: /border-(red|green|yellow|blue|indigo|orange|gray|purple|pink)-(50|100|200|300|400|500|600|700|800|900)/ },
    // Dynamic layout
    'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4', 'grid-cols-12',
    'col-span-1', 'col-span-2', 'col-span-8',
    'opacity-50', 'opacity-60', 'grayscale',
    'animate-bounce', 'animate-spin', 'animate-pulse',
    // Modal z-indexes
    'z-50', 'z-40', 'z-10',
    'md:col-span-2', 'md:col-span-8', 'md:col-span-1',
    'sm:grid-cols-2', 'md:grid-cols-3', 'lg:grid-cols-4',
    'top-\\[135px\\]',
  ]
}
