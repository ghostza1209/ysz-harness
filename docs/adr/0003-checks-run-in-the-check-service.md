# Checks run in the Project's Check service, read from the running container

ADR 0002 ran fazwaz's PHP checks on the host, with fazwaz's layout hardcoded: workdir `/var/www`, `<repo>/vendor`, network `<project>_default`. `/onboard-project` must onboard any Project whose checks need a stack the sandbox can't run, so this generalizes it to any language's Check service. The command becomes `service-check` (env `SERVICE_CHECK_URL`/`SERVICE_CHECK_TOKEN`), and the Project field becomes `checkService: { composeProject, service, depsDirs }`. No aliases are kept for the old names, because fazwaz is their only user.

For each command, the host reads the workdir, the networks and the bind mounts from the running service container. The workdir is the destination of the mount whose source is the repo. The clone mounts there, and each `depsDirs` entry mounts read-only from the real repo. Of the service's other bind mounts, only those whose source lies inside the repo are passed on, read-only (e.g. fazwaz's `dev.ini`). Mounts outside the repo, named volumes and sockets are dropped. A compose file can mount `docker.sock` or `~/.ssh`, and passing those on would reopen the escape ADR 0001 and 0002 closed. `depsDirs` must also resolve inside the repo. ADR 0002's security rule stands: the host builds every `docker run` flag itself, and the agent's argv always goes after the image name.

## Considered Options

- **Explicit fields for workdir, network and mounts**: more for the skill to draft, and they drift from the compose file.
- **Pass on every bind mount except sockets**: a denylist has to guess what is dangerous. The repo-path allowlist does not.
- **PHP only, keep `php-check`**: a Node or other stack checked in a compose service would need the same thing under another name.
