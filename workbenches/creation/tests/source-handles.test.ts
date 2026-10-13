import { describe, expect, it } from 'vitest';
import type { AssetVersion } from '@signal-room/workflow-spaces';
import { assertUniqueSourceHandles, sourceHandleIndex, resolveSourceReferences,
  sourceReferenceIssues } from '../src/spaces/source-handles.js';

const material = (items: unknown[], id = 'materials-v1') => ({ id, payloadHash: 'hash-m1',
  schema: { namespace: 'creation/content-materials', revision: '1', hash: 'schema-hash' }, payload: items }) as AssetVersion;
const research = (notes: unknown[]) => ({ id: 'research-v2', payloadHash: 'hash-r2',
  schema: { namespace: 'creation/content-research', revision: '1', hash: 'schema-hash' }, payload: { notes } }) as AssetVersion;

describe('exact content source handles', () => {
  it('maps source IDs to persisted array positions and versions', () => {
    const index = sourceHandleIndex(material([{ id: 'S1', title: 'First', text: 'a' },
      { id: 'S2', title: 'Second', text: 'b' }]), research([{ id: 'N1', title: 'Note', keyPoints: ['point'] }]));
    expect(index.byRef.get('S2')).toEqual([{ ref: 'S2', label: 'Second', excerpt: 'b',
      assetVersionId: 'materials-v1', payloadHash: 'hash-m1', pointer: '/1', kind: 'material' }]);
    expect(index.byRef.get('N1')?.[0]).toMatchObject({ assetVersionId: 'research-v2', pointer: '/notes/0' });
  });

  it('rejects unknown and ambiguous IDs with exact output paths and values', () => {
    const duplicate = sourceHandleIndex(material([{ id: 'S1', title: 'One', text: 'a' },
      { id: 'S1', title: 'Two', text: 'b' }]));
    expect(() => assertUniqueSourceHandles(duplicate)).toThrow('/1/id');
    const payload = { script: { sourcesUsed: ['S99', 'S1', 'S1 https://example.com'] },
      decision: { beats: [{ evidence: ['S1'] }] } };
    expect(sourceReferenceIssues('author', payload, duplicate)).toEqual([
      { ref: 'S99', path: '/script/sourcesUsed/0', code: 'SOURCE_ID_MISSING', matches: 0 },
      { ref: 'S1', path: '/script/sourcesUsed/1', code: 'SOURCE_ID_AMBIGUOUS', matches: 2 },
      { ref: 'S1 https://example.com', path: '/script/sourcesUsed/2', code: 'SOURCE_ID_MISSING', matches: 0 },
      { ref: 'S1', path: '/decision/beats/0/evidence/0', code: 'SOURCE_ID_AMBIGUOUS', matches: 2 },
    ]);
    expect(() => resolveSourceReferences('author', payload, duplicate)).toThrow('/script/sourcesUsed/0');
  });

  it('accepts a research answer only with an exact frozen source ID', () => {
    const index = sourceHandleIndex(material([{ id: 'S1', title: 'One', text: 'a' }]));
    expect(resolveSourceReferences('researcher', { questions: [{ materialRefs: ['S1'] }] }, index)[0]?.handle?.pointer).toBe('/0');
    expect(sourceReferenceIssues('researcher', { questions: [{ materialRefs: ['S1/link'] }] }, index)[0])
      .toMatchObject({ path: '/questions/0/materialRefs/0', ref: 'S1/link' });
  });
});
