---
status: superseded by ADR-0002
---

# fazwaz sandbox mounts the host Docker socket

fazwaz runs all PHP tooling (phpunit, phpstan, artisan) via `docker compose exec php` against the host's compose stack, so the Orchestrator bind-mounts `/var/run/docker.sock` into fazwaz's sandbox. That gives the agent effective root on the host, which we accept because the Orchestrator is single-user on localhost and only works Tickets the user labelled `ready-for-agent` themselves; without the socket the agent could not run any PHP check and every fazwaz PR would rely on CI alone. Other Projects do not get the socket.
