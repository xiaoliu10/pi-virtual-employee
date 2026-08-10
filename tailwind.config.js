/** @type {import('tailwindcss').Config} */
export default {
	content: ["./renderer/index.html", "./renderer/src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				// Deep slate/navy sidebar — warm amber accent, no neon/violet.
				ink: {
					900: "#0f1724",
					800: "#1b2738",
					700: "#283548",
					600: "#3a475c",
				},
				accent: {
					DEFAULT: "#e0a458",
					soft: "#f0c987",
				},
			},
			fontFamily: {
				sans: [
					"ui-sans-serif",
					"system-ui",
					"-apple-system",
					"PingFang SC",
					"Microsoft YaHei",
					"Segoe UI",
					"sans-serif",
				],
			},
		},
	},
	plugins: [],
};
