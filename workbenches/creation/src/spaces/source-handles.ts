import type { AssetVersion } from '@signal-room/workflow-spaces';

export interface SourceHandle {
  ref: string;
  label: string;
  excerpt: string;
  assetVersionId: string;
  payloadHash: string;
  pointer: string;
  kind: 'material' | 'research-note';
}
export interface SourceReference { ref: string; path: string }
export interface SourceReferenceIssue extends SourceReference {
  code: 'SOURCE_ID_MISSING' | 'SOURCE_ID_AMBIGUOUS' | 'SOURCE_ID_MALFORMED';
  matches: number;
}
export interface SourceHandleIndex {
  handles: readonly SourceHandle[];
  byRef: ReadonlyMap<string, readonly SourceHandle[]>;
  /** Legacy researcher notes cited in the same unpublished output have no asset ID yet. */
  pendingNotes: ReadonlyMap<string, readonly string[]>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const pointer = (path: string, index: number) => `${path}/${index}`;

/** Stable handles from the exact persisted material array and optional exact research notes. */
export function sourceHandleIndex(materials: AssetVersion, research?: AssetVersion,
  researchOutput?: unknown): SourceHandleIndex {
  if ((materials.schema && materials.schema.namespace !== 'creation/content-materials') || !Array.isArray(materials.payload))
    throw new Error('Source handles require a persisted content-materials array');
  if (research && researchOutput !== undefined) throw new Error('Choose one exact research-note parent');
  const handles: SourceHandle[] = [];
  const append = (items: unknown[], parent: AssetVersion, path: string, kind: SourceHandle['kind']) => {
    items.forEach((item, index) => {
      const value = record(item);
      const ref = string(value.id);
      if (!ref.trim() || ref !== ref.trim()) throw new Error(`Source ${pointer(path, index)}/id is empty or malformed`);
      const label = string(value.title) || ref;
      handles.push({ ref, label, excerpt: kind === 'material' ? string(value.text) : list(value.keyPoints).map(string).filter(Boolean).join('\n'),
        assetVersionId: parent.id, payloadHash: parent.payloadHash ?? '', pointer: pointer(path, index), kind });
    });
  };
  append(materials.payload, materials, '', 'material');
  if (research) {
    if (research.schema && research.schema.namespace !== 'creation/content-research') throw new Error('Research note parent schema mismatch');
    append(list(record(research.payload).notes), research, '/notes', 'research-note');
  }
  const pendingNotes = new Map<string, string[]>();
  if (researchOutput !== undefined) list(record(researchOutput).notes).forEach((item, index) => {
    const ref = string(record(item).id);
    if (!ref.trim() || ref !== ref.trim()) throw new Error(`Source /notes/${index}/id is empty or malformed`);
    pendingNotes.set(ref, [...(pendingNotes.get(ref) ?? []), `/notes/${index}`]);
  });
  const byRef = new Map<string, SourceHandle[]>();
  handles.forEach(handle => byRef.set(handle.ref, [...(byRef.get(handle.ref) ?? []), handle]));
  return { handles, byRef, pendingNotes };
}

export function contentSourceReferences(nodeId: string, payload: unknown): SourceReference[] {
  const data = record(payload);
  const references: SourceReference[] = [];
  if (nodeId === 'researcher') list(data.questions).forEach((item, index) =>
    list(record(item).materialRefs).forEach((ref, refIndex) =>
      references.push({ ref: string(ref), path: `/questions/${index}/materialRefs/${refIndex}` })));
  if (nodeId === 'author') {
    list(record(data.script).sourcesUsed).forEach((ref, index) =>
      references.push({ ref: string(ref), path: `/script/sourcesUsed/${index}` }));
    list(record(data.decision).beats).forEach((beat, index) =>
      list(record(beat).evidence).forEach((ref, refIndex) =>
        references.push({ ref: string(ref), path: `/decision/beats/${index}/evidence/${refIndex}` })));
  }
  return references;
}

/** Values stay exact: URL concatenation, unknown IDs and duplicate IDs are never guessed. */
export function sourceReferenceIssues(nodeId: string, payload: unknown, index: SourceHandleIndex): SourceReferenceIssue[] {
  return contentSourceReferences(nodeId, payload).flatMap<SourceReferenceIssue>(({ ref, path }) => {
    const matches = (index.byRef.get(ref)?.length ?? 0) + (index.pendingNotes.get(ref)?.length ?? 0);
    if (!ref.trim() || ref !== ref.trim()) return [{ ref, path, code: 'SOURCE_ID_MALFORMED' as const, matches }];
    if (matches !== 1) return [{ ref, path, code: matches ? 'SOURCE_ID_AMBIGUOUS' as const : 'SOURCE_ID_MISSING' as const, matches }];
    return [];
  });
}

/** Input quality gate before any model sees a map with ambiguous source IDs. */
export function assertUniqueSourceHandles(index: SourceHandleIndex): void {
  for (const [ref, handles] of index.byRef) {
    if (handles.length > 1) throw new Error(`CONTENT source SOURCE_ID_AMBIGUOUS at ${handles[1]!.pointer}/id: ${JSON.stringify(ref)} (${handles.length} matches)`);
  }
}

export function resolveSourceReferences(nodeId: string, payload: unknown, index: SourceHandleIndex):
  Array<{ reference: SourceReference; handle?: SourceHandle; pendingNotePointer?: string }> {
  const issues = sourceReferenceIssues(nodeId, payload, index);
  if (issues.length) {
    const first = issues[0]!;
    throw new Error(`CONTENT source ${first.code} at ${first.path}: ${JSON.stringify(first.ref)} (${first.matches} matches)`);
  }
  return contentSourceReferences(nodeId, payload).map(reference => ({ reference,
    ...(index.byRef.get(reference.ref)?.[0] ? { handle: index.byRef.get(reference.ref)![0]! }
      : { pendingNotePointer: index.pendingNotes.get(reference.ref)![0]! }) }));
}
