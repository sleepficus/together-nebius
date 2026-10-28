/** Disposable local-Git workspaces; filesystem access, no cloud token claim. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail } from '../lib/core.ts';
import type { ArtifactsAdapter } from '../lib/types.ts';
export function createLocalWorkspaceAdapter(repo: string, root: string): ArtifactsAdapter {
  return {
    async readFile(path) {
      if (!path || path.startsWith('/') || path.split('/').includes('..')) fail(422, 'invalid_path', 'relative Git path required');
      const r = spawnSync('git', ['-C', repo, 'show', `HEAD:${path}`], { maxBuffer: 1024 * 1024, timeout: 10000 });
      return r.status === 0 ? new Blob([new Uint8Array(r.stdout)]) : null;
    },
    async fork(repositoryId, name) {
      if (repositoryId !== 'local') fail(422, 'artifact_repo_mismatch', 'workspace is bound to the configured local repository');
      if (!name || !/^assignment-[a-zA-Z0-9_.-]+$/.test(name)) fail(422, 'invalid_name', 'assignment workspace name required');
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const target = join(root, name);
      if (!existsSync(target)) {
        const clone = spawnSync('git', ['clone', '--no-local', '--template=', repo, target], { timeout: 30000, maxBuffer: 1024 * 1024 });
        if (clone.status !== 0) fail(503, 'workspace_unavailable', 'local Git fork could not be created');
      } else {
        const origin = spawnSync('git', ['-C', target, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
        if (origin.status !== 0 || origin.stdout.trim() !== repo) fail(409, 'workspace_collision', 'existing directory is not this repository fork');
      }
      return { repo: { id:name, name, remote:pathToFileURL(target).href, ready:true, status:'ready', access:'local-filesystem' }, token:null };
    },
  };
}
