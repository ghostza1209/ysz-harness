# fazwaz PHP checks run by the host, not through a Docker socket

fazwaz's sandbox no longer gets the host Docker socket (ADR 0001): the socket gave a prompt-injected agent root on the host. Instead, for each agent the Orchestrator opens a listener on host loopback with a random token. The sandbox reaches it through `host.docker.internal`. The agent sends only the argv of a PHP command, and the host runs it in a throwaway container from the compose `php` service's image: it mounts that Run's clone and the repo's `vendor` read-only, on `fazwaz_default`. The host builds every `docker run` flag itself, and the agent's argv always goes after the image name, so it can only ever be the container's command. The agent can still run any PHP against the dev stack's database. We accept that, because tests need it and the database is local dev data. What this closes is escape to the host.

## Considered Options

- **Off-the-shelf docker-socket-proxy** (e.g. Tecnativa): it filters by API endpoint only. It cannot see the `POST /containers/create` body, so `Privileged`, host `Binds` and `PidMode: host` all get through.
- **A custom proxy that inspects request bodies**: a denylist over dozens of HostConfig escape fields, plus every endpoint the `docker run` CLI uses (create, attach, start, wait, rm). It is fragile, and done correctly it ends up as this narrow interface anyway.
- **No PHP checks in the sandbox**: every fazwaz PR would rely on CI alone.
