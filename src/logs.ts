import { appendFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A Run's log: its agent log files (`<runId>-attempt<n>-<role>.log`, written by sandcastle) read as one stream, oldest Attempt first, then its host log. */
export interface RunLogs {
  /** Total bytes across the Run's log files; 0 while none exists yet. */
  size(runId: number): Promise<number>;
  /** Bytes [from, to) of the concatenated log; shorter if the files hold less. */
  slice(runId: number, from: number, to: number): Promise<Buffer>;
}

export function createRunLogs(dir: string): RunLogs {
  async function files(runId: number) {
    const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const re = new RegExp(`^${runId}-(?:attempt(\\d+)-(implement|review)|host)\\.log$`);
    const found = names.flatMap((name) => {
      const m = re.exec(name);
      // The host log comes after every Attempt: the host steps that write it run once the agents are done.
      return m ? [{ path: join(dir, name), attempt: m[1] ? Number(m[1]) : Infinity, role: m[2] ?? '' }] : [];
    });
    // "implement" sorts before "review", which is the order the agents run in.
    found.sort((a, b) => a.attempt - b.attempt || a.role.localeCompare(b.role));
    return Promise.all(found.map(async (f) => ({ path: f.path, size: (await stat(f.path)).size })));
  }

  return {
    async size(runId) {
      return (await files(runId)).reduce((sum, f) => sum + f.size, 0);
    },

    async slice(runId, from, to) {
      const parts: Buffer[] = [];
      let offset = 0;
      for (const f of await files(runId)) {
        const start = Math.max(from, offset);
        const end = Math.min(to, offset + f.size);
        if (end > start) {
          const handle = await open(f.path);
          try {
            const buf = Buffer.alloc(end - start);
            const { bytesRead } = await handle.read(buf, 0, buf.length, start - offset);
            parts.push(buf.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        }
        offset += f.size;
      }
      return Buffer.concat(parts);
    },
  };
}

/** Append a line to a Run's host log, `<runId>-host.log`. */
export function appendRunLog(dir: string, runId: number, line: string): void {
  appendFileSync(join(dir, `${runId}-host.log`), `${line}\n`);
}
