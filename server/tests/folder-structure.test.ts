import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFolderTree, walkMediaFilesInFolder } from "../src/index.ts";

test("buildFolderTree counts only direct files in each folder", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "tagger-root-"));

  try {
    mkdirSync(path.join(rootDir, "images", "nested"), { recursive: true });
    writeFileSync(path.join(rootDir, "root.jpg"), "root-image");
    writeFileSync(path.join(rootDir, "images", "one.jpg"), "image-1");
    writeFileSync(path.join(rootDir, "images", "nested", "two.jpg"), "image-2");

    const tree = await buildFolderTree(rootDir, rootDir);

    assert.equal(tree.name, path.basename(rootDir));
    assert.equal(tree.imageCount, 1);
    assert.equal(tree.gifCount, 0);
    assert.equal(tree.videoCount, 0);
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0].name, "images");
    assert.equal(tree.children[0].imageCount, 1);
    assert.equal(tree.children[0].gifCount, 0);
    assert.equal(tree.children[0].videoCount, 0);
    assert.equal(tree.children[0].children.length, 1);
    assert.equal(tree.children[0].children[0].name, "nested");
    assert.equal(tree.children[0].children[0].imageCount, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("walkMediaFilesInFolder only lists files in the selected folder", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "tagger-root-"));

  try {
    mkdirSync(path.join(rootDir, "nested"), { recursive: true });
    writeFileSync(path.join(rootDir, "root.jpg"), "root-image");
    writeFileSync(path.join(rootDir, "nested", "child.jpg"), "nested-image");

    const rootFiles = await walkMediaFilesInFolder(rootDir, rootDir, false);

    assert.equal(rootFiles.length, 1);
    assert.equal(path.basename(rootFiles[0].fullPath), "root.jpg");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
