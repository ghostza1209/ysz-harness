/** Docker's human size: "1.2GiB" is binary, "12.3MB" and "4kB" decimal. NaN when it is not one ("--"). */
export function parseSize(text: string): number {
  const m = /^([\d.]+)\s*([kmgt]?)(i?)b$/i.exec(text.trim());
  if (!m) return NaN;
  return Number(m[1]) * (m[3] ? 1024 : 1000) ** (m[2] ? 'kmgt'.indexOf(m[2].toLowerCase()) + 1 : 0);
}

/** One `docker stats --format '{{json .}}'` line as cores, memory bytes and network-in bytes; undefined if it holds no CPU or memory reading. */
export function parseStats(line: string): { cores: number; memory: number; rx: number } | undefined {
  try {
    const s = JSON.parse(line);
    const cores = parseFloat(s.CPUPerc) / 100;
    const memory = parseSize(s.MemUsage.split('/')[0]);
    return Number.isFinite(cores) && Number.isFinite(memory) ? { cores, memory, rx: parseSize(s.NetIO.split('/')[0]) || 0 } : undefined;
  } catch {
    return undefined;
  }
}
