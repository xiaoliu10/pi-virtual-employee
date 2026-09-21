/** @type {import('tailwindcss').Config} */
export default {
	content: ["./renderer/index.html", "./renderer/src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				// pi-desktop dark slate system: app #11141a / panel #191c22 /
				// surface #20242c / hover #303642 / line #30343c / text #edf0f4.
				// The slate/blue/emerald/amber/red scales are INVERTED so the
				// existing light-theme utilities resolve to dark equivalents
				// (light shade = subtle surface, dark shade = bright text).
				ink: {
					900: "#11141a",
					800: "#191c22",
					700: "#20242c",
					600: "#303642",
				},
				accent: {
					DEFAULT: "#a8c9ff",
					soft: "#98b7f0",
				},
				slate: {
					50: "#161a21",
					100: "#20242c",
					200: "#30343c",
					300: "#4a5160",
					400: "#8b93a1",
					500: "#77808f",
					600: "#98a2b3",
					700: "#c3cad6",
					800: "#dde2ea",
					900: "#edf0f4",
					950: "#f5f7fa",
				},
				blue: {
					50: "#1a2233",
					100: "#20293c",
					200: "#2b3a55",
					300: "#3a4d6e",
					400: "#5b7fc7",
					500: "#98b7f0",
					600: "#a8c9ff",
					700: "#c3d9ff",
				},
				emerald: {
					50: "#14261c",
					400: "#34c759",
					500: "#4cd964",
					600: "#5fd38a",
					700: "#8fe8b4",
				},
				amber: {
					50: "#2a2318",
					200: "#4a3c22",
					300: "#f5cd8a",
					400: "#f0b95a",
					500: "#eab55c",
					600: "#eab55c",
					700: "#f3c877",
				},
				red: {
					50: "#331a17",
					500: "#ff7a6e",
					600: "#ff8a80",
				},
				rose: {
					50: "#331a17",
					200: "#4a2b28",
					400: "#ff9a90",
					500: "#ff8a80",
					600: "#ff8a80",
				},
				cyan: {
					50: "#12262b",
					600: "#7cc4d8",
					700: "#9dd3e3",
				},
				violet: {
					50: "#211d33",
					600: "#b9a8ec",
				},
				sky: {
					300: "#a8d4ee",
					600: "#86c5ec",
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
