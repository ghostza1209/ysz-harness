// npm run bug. Must work while ysz is down or broken: import only bugReport, never main, openStore or (statically) projects.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gatherFacts, generalReportLink } from './bugReport';

const link = generalReportLink(await gatherFacts(fileURLToPath(new URL('..', import.meta.url))));
console.log(link);
// A failure to open is not an error: the link is printed.
execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [link], () => {});
