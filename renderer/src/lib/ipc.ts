/** Typed handle to the bridged API + base URL helper for the local transport. */
import type { RendererApi } from "../vite-env.d.ts";

export const api: RendererApi = window.api;

export function baseUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}
