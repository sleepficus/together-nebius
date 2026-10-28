// together-cli — explicit work-pickup CLI over the shared Together client
// (seat b-swe-06). Every subcommand is a deliberate action the agent (or a
// native-client tool bridge) chooses to run; nothing here launches
// sessions, polls forever, or replays a stale consequential write. A 409
// is printed with its server-supplied next action and a non-zero exit
// code — re-reading and retrying is the caller's decision.
//
// Config (environment, Together-scoped only):
//   TOGETHER_BASE_URL    e.g. http://localhost:8787
//   TOGETHER_TOKEN       scoped platform credential from enrollment
//   TOGETHER_PROJECT_ID  the project this CLI acts on
//
// Exit codes: 0 ok, 1 unreachable/server failure, 2 usage/config error,
// 3 stale or conflict (409) — shown, never auto-retried.

import {
  ClientConfigError, clientFromEnv, type ApiResult, type TogetherClient,
} from './client.ts';

const USAGE = `together-cli — explicit work pickup for a Together project

config: TOGETHER_BASE_URL, TOGETHER_TOKEN, TOGETHER_PROJECT_ID

commands:
  status                          platform reachability (provider/inference stay UNKNOWN)
  brief [--task ID]               project or task brief, latest handoff verbatim
  inbox [--after CURSOR] [--limit N]
  ack MESSAGE_ID                  record a read receipt
  accept MESSAGE_ID [--task-revision N]
  reply MESSAGE_ID --text "..."
  tasks [--state S] [--cursor C]
  claim TASK_ID [--role ROLE]
  offer TASK_ID --to ID [--role R] [--ttl-ms N] [--note ".."] [--scope S ...]
  ask-help TASK_ID --question ".." [--to ID] [--expected ".."]
  accept-help HELP_ID
  answer-help HELP_ID --answer ".."
  handoff ASSIGNMENT_ID --done ".." --next ".." [--uncertain ".."] \
          [--verify-first ".."] [--do-not-repeat ".."] [--to ID]
  handoff-md --task TASK_ID       print generated HANDOFF.md (ignored file)
  workspace ASSIGNMENT_ID         open the claimed fork (token shown once)
  operation OPERATION_ID          look up a durable operation
`;

interface CliIo {
  env: Record<string, string | undefined>;
  out: (s: string) => void;
  err: (s: string) => void;
  fetchFn?: typeof fetch;
}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      // Both spellings work: --name value and --name=value.
      const eq = a.indexOf('=');
      if (eq !== -1) {
        const name = a.slice(2, eq);
        flags.set(name, [...(flags.get(name) ?? []), a.slice(eq + 1)]);
        continue;
      }
      const name = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, [...(flags.get(name) ?? []), next]);
        i += 1;
      } else {
        flags.set(name, [...(flags.get(name) ?? []), 'true']);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const flag1 = (flags: Map<string, string[]>, name: string): string | undefined =>
  flags.get(name)?.[0];

function requireFlag(flags: Map<string, string[]>, name: string): string {
  const v = flag1(flags, name);
  if (v === undefined || v === 'true') {
    throw new CliUsageError(`--${name} requires a value`);
  }
  return v;
}

/** Numeric flag: absent -> undefined; present but non-numeric -> usage error. */
function numFlag(flags: Map<string, string[]>, name: string): number | undefined {
  const v = flag1(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new CliUsageError(`--${name} must be a number, got "${v}"`);
  }
  return n;
}

/** Required positional argument; a missing one is a usage error, not a request. */
function requirePositional(positional: string[], index: number, name: string): string {
  const v = positional[index];
  if (v === undefined) {
    throw new CliUsageError(`missing ${name}`);
  }
  return v;
}

class CliUsageError extends Error {}

function printResult(io: CliIo, res: ApiResult): number {
  if (res.ok) {
    io.out(JSON.stringify(res.body, null, 2));
    return 0;
  }
  const code = res.error?.code ?? 'error';
  const staleNote = res.stale
    ? '\nstale: re-read the entity, then retry deliberately — this CLI never replays automatically'
    : '';
  io.err(
    `error ${res.status} ${code}: ${res.error?.message ?? 'request failed'}` +
      (res.error?.nextAction ? `\nnext: ${res.error.nextAction}` : '') +
      staleNote,
  );
  if (res.stale) return 3;
  if (res.status === 0 || (res.status >= 500 && res.status < 600)) return 1;
  return 2;
}

async function run(
  client: TogetherClient,
  cmd: string,
  positional: string[],
  flags: Map<string, string[]>,
  io: CliIo,
): Promise<number> {
  switch (cmd) {
    case 'status': {
      const status = await client.status();
      io.out(JSON.stringify(status, null, 2));
      return status.platform === 'connected' ? 0 : 1;
    }
    case 'brief':
      return printResult(io, await client.brief(flag1(flags, 'task')));
    case 'inbox':
      return printResult(io, await client.inbox({
        after: flag1(flags, 'after'),
        limit: numFlag(flags, 'limit'),
      }));
    case 'ack':
      return printResult(io, await client.ack(requirePositional(positional, 0, 'MESSAGE_ID')));
    case 'accept':
      return printResult(io, await client.accept(requirePositional(positional, 0, 'MESSAGE_ID'), {
        taskRevision: numFlag(flags, 'task-revision'),
      }));
    case 'reply':
      return printResult(io, await client.reply(requirePositional(positional, 0, 'MESSAGE_ID'), requireFlag(flags, 'text')));
    case 'tasks':
      return printResult(io, await client.tasks({
        state: flag1(flags, 'state'),
        cursor: flag1(flags, 'cursor'),
      }));
    case 'claim':
      return printResult(io, await client.claimTask(requirePositional(positional, 0, 'TASK_ID'), {
        role: flag1(flags, 'role'),
        scopes: flags.get('scope'),
      }));
    case 'offer':
      return printResult(io, await client.offer(requirePositional(positional, 0, 'TASK_ID'), {
        toId: requireFlag(flags, 'to'),
        role: flag1(flags, 'role'),
        scopes: flags.get('scope'),
        ttlMs: numFlag(flags, 'ttl-ms'),
        note: flag1(flags, 'note'),
      }));
    case 'ask-help':
      return printResult(io, await client.askHelp(requirePositional(positional, 0, 'TASK_ID'), {
        question: requireFlag(flags, 'question'),
        toId: flag1(flags, 'to'),
        expectedContribution: flag1(flags, 'expected'),
        ttlMs: numFlag(flags, 'ttl-ms'),
      }));
    case 'accept-help':
      return printResult(io, await client.acceptHelp(requirePositional(positional, 0, 'HELP_ID')));
    case 'answer-help':
      return printResult(io, await client.answerHelp(requirePositional(positional, 0, 'HELP_ID'), requireFlag(flags, 'answer')));
    case 'handoff':
      return printResult(io, await client.handoff(requirePositional(positional, 0, 'ASSIGNMENT_ID'), {
        done: requireFlag(flags, 'done'),
        next: requireFlag(flags, 'next'),
        uncertain: flag1(flags, 'uncertain'),
        verifyFirst: flag1(flags, 'verify-first'),
        doNotRepeat: flag1(flags, 'do-not-repeat'),
        toId: flag1(flags, 'to'),
      }));
    case 'handoff-md': {
      const taskId = requireFlag(flags, 'task');
      const res = await client.brief(taskId);
      if (!res.ok) return printResult(io, res);
      const handoff = res.body.handoff as { markdown?: string } | null | undefined;
      if (handoff && typeof handoff.markdown === 'string') {
        io.out(handoff.markdown);
      } else {
        io.out('<!-- no handoff recorded for this task -->');
      }
      return 0;
    }
    case 'workspace':
      return printResult(io, await client.workspace(requirePositional(positional, 0, 'ASSIGNMENT_ID')));
    case 'operation':
      return printResult(io, await client.operation(requirePositional(positional, 0, 'OPERATION_ID')));
    default:
      throw new CliUsageError(`unknown command "${cmd}"`);
  }
}

/**
 * Entry point. Returns the process exit code; injectable env/io/fetch make
 * it testable without a live server.
 */
export async function main(argv: string[], io?: Partial<CliIo>): Promise<number> {
  const ioFull: CliIo = {
    env: io?.env ?? process.env,
    out: io?.out ?? ((s) => console.log(s)),
    err: io?.err ?? ((s) => console.error(s)),
    fetchFn: io?.fetchFn,
  };
  const cmd = argv[0];
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    ioFull.out(USAGE);
    return cmd === undefined ? 2 : 0;
  }
  let client: TogetherClient;
  try {
    client = clientFromEnv(ioFull.env, ioFull.fetchFn);
  } catch (err) {
    if (err instanceof ClientConfigError) {
      ioFull.err(`${err.message}\nset the Together-scoped variables and retry`);
      return 2;
    }
    throw err;
  }
  const { positional, flags } = parseFlags(argv.slice(1));
  try {
    return await run(client, cmd, positional, flags, ioFull);
  } catch (err) {
    if (err instanceof CliUsageError) {
      ioFull.err(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    ioFull.err(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Executed directly: node adapters/cli.ts <command> ...
const invokedAs =
  typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv.length > 1
    ? process.argv[1]
    : undefined;
if (invokedAs !== undefined && import.meta.url === new URL(`file://${invokedAs}`).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
