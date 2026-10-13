import path from 'node:path';
import { createWorkspaceTools } from '@signal-room/workflow-agent-sdk';
import type { AgentRunRequest } from '@signal-room/workflow';
import type { SiwcTool } from '@signal-room/workflow-agent-sdk';
const objectArgs = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** B3 receives filesystem and command capabilities only through these path- and operation-bound tools. */
export async function creationB3AgentTools(request: AgentRunRequest<unknown>): Promise<readonly SiwcTool[]> {
  const input = objectArgs(request.input);
  const role = request.definition.id;
  if (role === 'b3-designer') {
    const episodeDir = typeof input.episodeDir === 'string' ? path.resolve(input.episodeDir) : '';
    const referenceDir = typeof input.referenceDir === 'string' ? path.resolve(input.referenceDir) : '';
    if (!path.isAbsolute(episodeDir) || !path.isAbsolute(referenceDir)) throw new Error('B3 designer requires exact absolute episode and reference directories');
    const tools = await createWorkspaceTools({ root: episodeDir, readRoots: [referenceDir],
      writePaths: ['frames-spec/'], commands: { check_frame_specs: {
        command: 'python3', args: ['scripts/build-frames.py', '--check'], timeoutMs: 120_000,
      } } });
    return tools.filter(tool => ['read_file', 'list_directory', 'write_file', 'exec_allowed'].includes(tool.name));
  }
  if (role === 'b3-inspector') {
    const contactSheets = Array.isArray(input.contactSheets) ? input.contactSheets.filter((item): item is string => typeof item === 'string').map(item => path.resolve(item)) : [];
    if (!contactSheets.length) throw new Error('B3 inspector requires the exact review image list');
    const root = path.dirname(contactSheets[0]!);
    const allowed = new Set(contactSheets.map(file => path.relative(root, file).split(path.sep).join('/')));
    if ([...allowed].some(file => file.startsWith('../') || path.isAbsolute(file))) throw new Error('B3 review images must share a run-scoped directory');
    const tools = await createWorkspaceTools({ root });
    const image = tools.find(tool => tool.name === 'read_image');
    if (!image) throw new Error('Shared workspace image tool is unavailable');
    return [{ ...image, description: 'Open one of the exact run-scoped review images supplied to this inspection.', execute: async (args, signal) => {
      const relative = objectArgs(args).path;
      if (typeof relative !== 'string' || !allowed.has(relative)) throw new Error('Inspector may open only this run and round’s supplied review images');
      return image.execute(args, signal);
    } }];
  }
  throw new Error(`Unregistered B3 agent role: ${role}`);
}
