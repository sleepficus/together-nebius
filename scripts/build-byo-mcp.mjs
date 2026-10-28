import {build} from 'esbuild';
await build({entryPoints:['adapters/byo-mcp.ts'],outfile:'dist/mcp/together-byo.mjs',bundle:true,platform:'node',target:'node22',format:'esm'});
