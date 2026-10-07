import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const VIDEO_FILE = 'video.mp4';
const MANIFEST_FILE = 'video.json';

/** Prefer the actual rendered frames; accept older snapshot script outputs as fallbacks. */
export function selectB3ReviewImages(episodeDir: string): string[] {
  const settleDir = path.join(episodeDir, 'snapshots/settle');
  const files = existsSync(settleDir) ? readdirSync(settleDir) : [];
  const numbered = (name: string) => Number(/^\D+?(\d+)/.exec(name)?.[1] ?? 0);
  const sortNumbered = (a: string, b: string) => numbered(a) - numbered(b) || a.localeCompare(b);
  const frames = files.filter(name => /^frame-\d+-at-.*\.png$/.test(name)).sort(sortNumbered);
  if (frames.length) return frames.map(name => path.join(settleDir, name));
  if (files.includes('contact-sheet.jpg')) return [path.join(settleDir, 'contact-sheet.jpg')];
  const nativeSheets = files.filter(name => /^contact-sheet-\d+\.jpg$/.test(name)).sort(sortNumbered);
  if (nativeSheets.length) return nativeSheets.map(name => path.join(settleDir, name));
  const reviewDir = path.join(episodeDir, 'snapshots/review');
  return existsSync(reviewDir)
    ? readdirSync(reviewDir).filter(name => /^contact-\d+\.jpg$/.test(name)).sort(sortNumbered).map(name => path.join(reviewDir, name))
    : [];
}

/** Preserve the images inspected in a run and round before the shared review folder is reused. */
export function saveRunContactSheets(runDir: string, round: number, sources: string[]): string[] {
  if (!sources.length) throw new Error('B3 snapshot review produced no contact sheets');
  const targetDir = path.join(runDir, 'snapshots', `round-${round + 1}`);
  mkdirSync(targetDir, { recursive: true });
  return sources.map(source => {
    if (!path.isAbsolute(source) || !existsSync(source) || statSync(source).size === 0) {
      throw new Error(`B3 contact sheet has no readable image: ${source}`);
    }
    const name = path.basename(source);
    if (!/^(?:frame-\d+-at-.*\.png|contact-sheet(?:-\d+)?\.jpg|contact-\d+\.jpg)$/.test(name)) {
      throw new Error(`B3 review image has an unexpected name: ${source}`);
    }
    const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
    const target = path.join(targetDir, name.replace(/\.(png|jpg)$/, `-${hash}.$1`));
    if (!existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL);
    if (createHash('sha256').update(readFileSync(target)).digest('hex') !== hash) {
      throw new Error(`B3 saved contact sheet does not match its image hash: ${target}`);
    }
    return target;
  });
}

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
    const bytes = readFileSync(target);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path.join(runDir, MANIFEST_FILE), `${JSON.stringify({ file: VIDEO_FILE, source, producerStepRunId, sha256, bytes: bytes.byteLength }, null, 2)}\n`);
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
