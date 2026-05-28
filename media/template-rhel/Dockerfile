ARG BASE_IMAGE=registry.access.redhat.com/ubi9/nodejs-20
FROM ${BASE_IMAGE}

ARG TZ
ENV TZ="$TZ"

USER root

# Install basic development tools (RHEL family = dnf, or microdnf on -minimal images)
RUN ( command -v dnf >/dev/null && dnf install -y --setopt=tsflags=nodocs \
      less git procps-ng sudo unzip gnupg2 \
      iptables ipset iproute bind-utils iputils \
      jq nano vim-enhanced wget tar gzip ca-certificates \
      && dnf clean all ) || \
    ( command -v microdnf >/dev/null && microdnf install -y \
      less git procps-ng sudo unzip gnupg2 \
      iptables ipset iproute bind-utils iputils \
      jq nano vim-enhanced wget tar gzip ca-certificates \
      && microdnf clean all )

# Ensure a `dev` user (uid 1000) exists. UBI's nodejs image uses `default` at uid 1001
# (so uid 1000 is free). If user picks a node:N base instead, uid 1000 is taken by
# `node` — drop it first.
ARG USERNAME=dev
RUN if ! id -u $USERNAME >/dev/null 2>&1; then \
      if getent passwd 1000 >/dev/null 2>&1; then \
        EXISTING=$(getent passwd 1000 | cut -d: -f1); \
        userdel -r "$EXISTING" 2>/dev/null || true; \
      fi; \
      groupadd -g 1000 $USERNAME && \
      useradd -m -u 1000 -g 1000 -s /bin/bash $USERNAME; \
    fi

ENV DEVCONTAINER=true

# /home/$USERNAME is a volume mount target — its contents (including .bashrc seeded
# from /etc/skel) are copied into the volume on first run and persist across rebuilds.
RUN mkdir -p /workspace && chown -R $USERNAME:$USERNAME /workspace

WORKDIR /workspace

# git-delta — glibc release (RHEL family uses glibc)
ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(uname -m) && \
  case "$ARCH" in \
    x86_64)  DARCH=x86_64 ;; \
    aarch64) DARCH=aarch64 ;; \
    *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
  esac && \
  wget -O- "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/delta-${GIT_DELTA_VERSION}-${DARCH}-unknown-linux-gnu.tar.gz" | tar -xz -C /tmp && \
  mv /tmp/delta-*-${DARCH}-unknown-linux-gnu/delta /usr/local/bin/delta && \
  rm -rf /tmp/delta-*

USER $USERNAME

ENV EDITOR=nano
ENV VISUAL=nano

COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "${USERNAME} ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/${USERNAME}-firewall && \
  chmod 0440 /etc/sudoers.d/${USERNAME}-firewall
USER $USERNAME
