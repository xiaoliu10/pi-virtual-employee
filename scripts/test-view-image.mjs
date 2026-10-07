import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createViewImageTool } from "../src/engine/tools/view-image.ts";

const dir = await mkdtemp(join(tmpdir(), "view-image-"));
test.after(() => rm(dir, { recursive: true, force: true }));

// 1x1 red PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngPath = join(dir, "shot.png");
await writeFile(pngPath, Buffer.from(PNG_B64, "base64"));

const firstText = (result) => result.content.find((block) => block.type === "text")?.text ?? "";
const imageBlock = (result) => result.content.find((block) => block.type === "image");

test("vision model: local image file lands in context as a real image block", async () => {
	const tool = createViewImageTool(() => true);
	const result = await tool.execute("t1", { filePath: pngPath });
	assert.equal(imageBlock(result).mimeType, "image/png");
	assert.equal(imageBlock(result).data, PNG_B64);
	assert.match(firstText(result), /已载入图片/);
	assert.equal(result.details.ok, true);
});

test("non-vision model: refuses with fix guidance, no image block, no fake success", async () => {
	const tool = createViewImageTool(() => false);
	const result = await tool.execute("t1", { filePath: pngPath });
	assert.equal(imageBlock(result), undefined);
	assert.match(firstText(result), /不支持图像输入/);
	assert.match(firstText(result), /不要假装识别/);
	assert.equal(result.details.ok, false);
});

test("non-image extension and missing file refuse cleanly", async () => {
	const tool = createViewImageTool(() => true);
	const bad = await tool.execute("t1", { filePath: join(dir, "notes.txt") });
	assert.match(firstText(bad), /仅支持/);
	const missing = await tool.execute("t1", { filePath: join(dir, "nope.png") });
	assert.match(firstText(missing), /读取图片失败/);
	assert.equal(missing.details.ok, false);
});

test("oversized image refuses before reading", async () => {
	const huge = join(dir, "huge.png");
	await writeFile(huge, Buffer.alloc(10 * 1024 * 1024 + 1, 0));
	const tool = createViewImageTool(() => true);
	const result = await tool.execute("t1", { filePath: huge });
	assert.match(firstText(result), /过大/);
	assert.equal(result.details.reason, "too_large");
});
