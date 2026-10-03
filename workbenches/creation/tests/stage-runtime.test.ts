import { describe, expect, test } from 'vitest';
import { stageRunnerOptions } from '../src/stages/runtime.js';

describe('stage agent environment', () => {
  test('content roles run on the chosen Codex executable without repository AGENTS.md', () => {
    expect(stageRunnerOptions('/opt/codex/bin/codex')).toEqual({
      codexOptions: { codexPathOverride: '/opt/codex/bin/codex', config: { project_doc_max_bytes: 0 } },
    });
  });

  test('without a known executable the SDK default is used and project docs stay off', () => {
    expect(stageRunnerOptions(undefined).codexOptions).toEqual({ config: { project_doc_max_bytes: 0 } });
  });
});
