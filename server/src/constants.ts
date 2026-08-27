import { readFileSync } from "fs";
import path from "path";
import type { MediaDescriptor } from "./types";

const loadServerEnv = (): void => {
  const envPath = path.resolve(__dirname, "../.env");

  try {
    const envFileContents = readFileSync(envPath, "utf8");
    envFileContents.split(/\r?\n/).forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) {
        return;
      }

      const separatorIndex = trimmedLine.indexOf("=");
      if (separatorIndex <= 0) {
        return;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine.slice(separatorIndex + 1).trim();
      if (!key || typeof process.env[key] === "string") {
        return;
      }

      process.env[key] = value;
    });
  } catch {
    // Ignore missing .env files and continue with existing process env.
  }
};

loadServerEnv();

export const port = Number(process.env.PORT ?? 3001);
export const testDirPath = path.resolve(__dirname, "../../outdir");
export const scanProgressInterval = Number(
  process.env.SCAN_PROGRESS_INTERVAL ?? 250,
);
export const isTestModeEnabled = process.env.TEST_MODE === "true";
export const testModeMaxSupportedFiles = 500;

export const mediaByExt: Record<string, MediaDescriptor> = {
  ".jpg": { mimeType: "image/jpeg", kind: "image" },
  ".jpeg": { mimeType: "image/jpeg", kind: "image" },
  ".png": { mimeType: "image/png", kind: "image" },
  ".gif": { mimeType: "image/gif", kind: "image" },
  ".webp": { mimeType: "image/webp", kind: "image" },
  ".bmp": { mimeType: "image/bmp", kind: "image" },
  ".mp4": { mimeType: "video/mp4", kind: "video" },
  ".mov": { mimeType: "video/quicktime", kind: "video" },
  ".m4v": { mimeType: "video/x-m4v", kind: "video" },
  ".webm": { mimeType: "video/webm", kind: "video" },
  ".mkv": { mimeType: "video/x-matroska", kind: "video" },
  ".avi": { mimeType: "video/x-msvideo", kind: "video" },
};
