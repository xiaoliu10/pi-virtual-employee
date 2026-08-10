/** Optional dependency: only present if the user installs pdf-parse. */
declare module "pdf-parse" {
	const pdfParse: (data: Buffer | Uint8Array) => Promise<{ text: string; numpages?: number; info?: unknown }>;
	export default pdfParse;
}
