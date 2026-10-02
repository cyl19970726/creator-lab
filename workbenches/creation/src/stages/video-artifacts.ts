import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const VIDEO_FILE = 'video.mp4';
const MANIFEST_FILE = 'video.json';

/** Keep the exact video named by this run's b3-video artifact beside its frozen input. */
export function saveRunVideo(runDir: string, source: string, producerStepRunId: string): string {
  if (!path.isAbsolute(source) || !existsSync(source) || statSync(source).size === 0) {
    throw new Error(`B3 video artifact has no readable output: ${source}`);
  }
  const target = path.join(runDir, VIDEO_FILE);
  const temporary = `${target}.tmp`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
    writeFileSync(path.join(runDir, MANIFEST_FILE), `${JSON.stringify({ file: VIDEO_FILE, source, producerStepRunId }, null, 2)}\n`);
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

/** Never search the mutable episode exports for an old run's video. */
export function findRunVideo(runDir: string, hasVideoArtifact: boolean): string | undefined {
  if (!hasVideoArtifact || !existsSync(runDir)) return undefined;
  const manifest = path.join(runDir, MANIFEST_FILE);
  if (existsSync(manifest)) {
    const data = JSON.parse(readFileSync(manifest, 'utf8')) as { file?: string };
    return data.file === VIDEO_FILE && existsSync(path.join(runDir, VIDEO_FILE)) ? VIDEO_FILE : undefined;
  }
  // Earlier runs sometimes saved a single, manually named video within their own run directory.
  // An ambiguous directory has no safe automatic choice.
  const videos = readdirSync(runDir).filter(file => file.endsWith('.mp4') && statSync(path.join(runDir, file)).isFile());
  return videos.length === 1 ? videos[0] : undefined;
}
