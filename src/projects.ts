import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Project {
  name: string;
  repoPath: string;
  baseBranch: string;
}

const projectsDir = join(homedir(), 'Desktop/projects');

// Edit and restart to add or change a Project.
export const projects: readonly Project[] = [
  { name: 'fazwaz', repoPath: join(projectsDir, 'work/fazwaz'), baseBranch: 'develop' },
  { name: 'PopDeal', repoPath: join(projectsDir, 'work/PopDeal'), baseBranch: 'develop' },
  { name: 'thaivis', repoPath: join(projectsDir, 'personal/app'), baseBranch: 'develop' },
];
