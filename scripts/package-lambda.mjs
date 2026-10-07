import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = resolve(root, "build/package");

if (!existsSync(resolve(root, "dist/index.js"))) {
  console.error("dist/index.js is missing. Run npm run build first.");
  process.exit(1);
}

rmSync(resolve(root, "build"), { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(resolve(root, "dist"), resolve(staging, "dist"), { recursive: true });
cpSync(resolve(root, "package.json"), resolve(staging, "package.json"));
cpSync(resolve(root, "package-lock.json"), resolve(staging, "package-lock.json"));
execSync("npm ci --omit=dev", { cwd: staging, stdio: "inherit" });
execSync("zip -r ../lambda.zip dist node_modules package.json package-lock.json", {
  cwd: staging,
  stdio: "inherit",
});
