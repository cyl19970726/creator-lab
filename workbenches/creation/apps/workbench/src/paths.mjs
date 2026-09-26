import path from "node:path";
import { fileURLToPath } from "node:url";
export const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const contentRoot = path.resolve(process.env.CREATION_CONTENT_ROOT || process.env.TOKEN_REPO_ROOT || applicationRoot);
export const stateRoot = path.resolve(process.env.CREATION_STATE_ROOT || path.join(applicationRoot, "data/local/workbench"));
export const mediaRoot = path.resolve(process.env.CREATION_MEDIA_ROOT || process.env.TOKEN_MEDIA_ROOT || path.join(applicationRoot, "media"));
