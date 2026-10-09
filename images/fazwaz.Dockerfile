FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  ripgrep \
  && rm -rf /var/lib/apt/lists/*

# fazwaz runs its PHP tooling through the host's compose stack (ADR 0001): the CLI and compose plugin talk to the
# host Docker socket that the Project mounts. Static binaries, so no daemon is installed.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose

# pnpm comes from corepack, which installs the version the repo's packageManager field pins.
RUN corepack enable

# Rename the base image's "node" user (UID 1000) to "agent": sandcastle expects that user.
RUN usermod -d /home/agent -m -l agent node
USER agent

ENV HOME=/home/agent

RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

RUN git config --global safe.directory '*'

# Sandcastle starts the container as the Project's containerUid:containerGid (1000), not the host UID.
# Let any UID write the home dir and the pre-created .gitconfig.
USER root
RUN chmod -R o+rwX /home/agent
USER agent

WORKDIR /home/agent

# No bd, no gh, no ssh: the agent only commits. Sandcastle bind-mounts the worktree at /home/agent/workspace.
ENTRYPOINT ["sleep", "infinity"]
