import { Router } from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const router = Router();

// Resolve path ke folder lua/ satu level di atas dist/ (saat sudah di-build)
// Source: src/routes/lua.ts -> dist/index.mjs -> ../lua/drm_wrapper.lua
const LUA_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../lua/drm_wrapper.lua"
);

router.get("/loader", async (_req, res) => {
  try {
    const content = await readFile(LUA_FILE, "utf-8");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(content);
  } catch {
    res.status(500).send("-- ERROR: Gagal memuat script loader.");
  }
});

export default router;
