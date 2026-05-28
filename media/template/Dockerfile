ARG BASE_IMAGE=node:20
FROM ${BASE_IMAGE}

ARG TZ
ENV TZ="$TZ"

USER root

# Install basic development tools and iptables/ipset.
# ca-certificates + wget are needed for the git-delta download (plain ubuntu lacks wget).
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  man-db \
  unzip \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  iputils-ping \
  aggregate \
  jq \
  nano \
  vim \
  ca-certificates \
  wget \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ensure a `dev` user (uid 1000) exists. If uid 1000 is taken (node:N images use it
# for `node`, plain ubuntu for `ubuntu`), drop the existing holder first.
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

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

USER $USERNAME

ENV EDITOR=nano
ENV VISUAL=nano

COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh && \
  echo "${USERNAME} ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/${USERNAME}-firewall && \
  chmod 0440 /etc/sudoers.d/${USERNAME}-firewall
USER $USERNAME
