import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Topic } from '../contracts/index.ts';
export const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const SourceRecord = z.object({
  id: z.string(),
  title: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string(),
  provenance: z.string(),
});
const Manifest = z.object({
  schemaVersion: z.literal(1),
  topics: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      goal: z.string(),
      readers: z.array(z.string()).min(1),
      sources: z.array(SourceRecord),
    }),
  ),
});
export function contentRepository(root: string) {
  const path = resolve(root, 'manifest.json');
  const read = () => Manifest.parse(JSON.parse(readFileSync(path, 'utf8')));
  function checked(path: string) {
    const actual = realpathSync(resolve(root, path));
    const rel = relative(realpathSync(root), actual);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Source outside content root');
    const stat = statSync(actual);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid source size');
    return { actual, stat };
  }
  return {
    topics(): Topic[] {
      if (!existsSync(path)) return [];
      return read().topics.map((t) => ({
        ...t,
        sources: t.sources.map((s) => ({
          id: s.id,
          title: s.title,
          sha256: s.sha256,
          provenance: s.provenance,
          size: checked(s.path).stat.size,
        })),
      }));
    },
    freeze(topicId: string, sourceIds: string[]) {
      const topic = read().topics.find((t) => t.id === topicId);
      if (!topic) throw new Error('Unknown topic');
      if (new Set(sourceIds).size !== sourceIds.length) throw new Error('Duplicate sources');
      let total = 0;
      const sources = sourceIds.map((id) => {
        const s = topic.sources.find((s) => s.id === id);
        if (!s) throw new Error('Source outside topic');
        const { actual } = checked(s.path);
        const content = readFileSync(actual, 'utf8');
        if (digest(content) !== s.sha256)
          throw new Error('Source changed; import a new immutable version');
        total += Buffer.byteLength(content);
        if (total > 6 * 1024 * 1024) throw new Error('Sources exceed 6 MiB');
        return { id: s.id, title: s.title, content, sha256: s.sha256 };
      });
      return { topic, sources };
    },
  };
}
