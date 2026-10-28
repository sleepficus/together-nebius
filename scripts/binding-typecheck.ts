/// <reference path="../worker-configuration.d.ts" />
// Compile-time compatibility with actual generated Wrangler binding types.
import type { ArtifactsNamespaceLike } from '../lib/artifacts.ts';
export function artifactsBinding(env: Cloudflare.Env): ArtifactsNamespaceLike {
  return env.ARTIFACTS;
}
