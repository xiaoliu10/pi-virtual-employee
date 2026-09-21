/** @type {import('tailwindcss').Config} */
export default {
	content: ["./renderer/index.html", "./renderer/src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				// pi-desktop LIGHT system (tokens.css .pireplica defaults):
				// bg #ffffff / sidebar #f6f6f7 / card #f7f7f8 / inset #f2f2f3 /
				// border rgba(0,0,0,0.08) / text #1d1d1f · #6e6e73 · #a1a1a6 /
				// primary button = near-black #1d1d1f. Status colors only.
				ink: {
					900: "#f6f6f7",
					800: "#ffffff",
					700: "#ebebec",
					600: "#dcdcdf",
				},
				accent: {
					DEFAULT: "#1d1d1f",
					soft: "#6e6e73",
				},
				slate: {
					50: "#f7f7f8",
					100: "#f2f2f3",
					200: "rgba(0,0,0,0.08)",
					300: "rgba(0,0,0,0.14)",
					400: "#a1a1a6",
					500: "#6e6e73",
					600: "#55555a",
					700: "#3f3f43",
					800: "#2a2a2d",
					900: "#1d1d1f",
					950: "#101012",
				},
				blue: {
					50: "#f2f2f3",
					100: "#ebebec",
					200: "rgba(0,0,0,0.10)",
					300: "rgba(0,0,0,0.16)",
					400: "#6e6e73",
					500: "#1d1d1f",
					600: "#1d1d1f",
					700: "#000000",
				},
				emerald: {
					50: "#e9f6ee",
					200: "#bfe3cc",
					300: "#7fcfa0",
					400: "#34c759",
					500: "#248a3d",
					600: "#248a3d",
					700: "#1c6b31",
				},
				amber: {
					50: "#fdf1e2",
					200: "#f0d9b5",
					300: "#f3c477",
					400: "#e5a63d",
					500: "#b45309",
					600: "#b45309",
					700: "#8a4208",
				},
				red: {
					50: "#fdeceb",
					500: "#d92c20",
					600: "#d92c20",
				},
				rose: {
					50: "#fdeceb",
					200: "#f5c7c2",
					400: "#e05a4c",
					500: "#d92c20",
					600: "#d92c20",
				},
				cyan: {
					50: "#f2f2f3",
					600: "#55555a",
					700: "#3f3f43",
				},
				violet: {
					50: "#f2f2f3",
					600: "#55555a",
				},
				sky: {
					300: "#6e6e73",
					600: "#3f3f43",
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
