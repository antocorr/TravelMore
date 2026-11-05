/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{js,html}'],
    theme: {
        extend: {
            colors: {
                ink: '#1d2926', paper: '#f5f5ef', moss: '#315c51', clay: '#d66c47', mist: '#e7ebe4',
            },
            fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'], serif: ['Iowan Old Style', 'Baskerville', 'Georgia', 'serif'] },
        },
    },
    plugins: [],
}
