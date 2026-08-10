import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite serves / builds the React renderer only. The Electron main + preload are
// bundled separately with esbuild (see scripts/), because pi-ai is ESM-only and
// the main process must stay ESM with a controlled __filename shim.
export default defineConfig({
	root: "renderer",
	base: "./",
	server: { port: 5173 },
	build: { outDir: "dist" },
	plugins: [react()],
});
