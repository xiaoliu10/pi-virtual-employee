import test from "node:test";
import assert from "node:assert/strict";
import { nextModelImage, resolveImageChecked } from "../renderer/src/lib/model-image.ts";

test("resolveImageChecked: explicit wins over effective", () => {
	assert.equal(resolveImageChecked(true, false), true);
	assert.equal(resolveImageChecked(false, true), false);
});

test("resolveImageChecked: undefined inherits effective", () => {
	assert.equal(resolveImageChecked(undefined, true), true);
	assert.equal(resolveImageChecked(undefined, false), false);
});

test("nextModelImage: set true/false writes explicit override", () => {
	assert.deepEqual(nextModelImage(undefined, "m", true), { m: true });
	assert.deepEqual(nextModelImage({ m: true }, "m", false), { m: false });
});

test("nextModelImage: inherit removes the key and collapses empty map", () => {
	assert.equal(nextModelImage({ m: true }, "m", "inherit"), undefined);
	assert.deepEqual(nextModelImage({ m: true, n: false }, "m", "inherit"), { n: false });
	assert.equal(nextModelImage(undefined, "m", "inherit"), undefined);
});

test("nextModelImage: immutability — input map untouched", () => {
	const map = { m: true };
	nextModelImage(map, "m", false);
	assert.deepEqual(map, { m: true });
});
