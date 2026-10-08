FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        chromium-sandbox \
        curl \
        fonts-dejavu-core \
        netcat-openbsd \
        socat \
        x11-utils \
        x11vnc \
        xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 browser \
    && useradd --uid 1000 --gid 1000 --home-dir /profile/home --no-create-home browser \
    && install -d -m 0700 -o 1000 -g 1000 /profile

ENV DISPLAY=:99 \
    HOME=/profile/home \
    XDG_CONFIG_HOME=/profile/config \
    XDG_CACHE_HOME=/tmp/chromium-cache \
    XDG_RUNTIME_DIR=/tmp/chat-browser-runtime

# Use this directory as the build context; no application files or credentials are copied.
COPY entrypoint.sh /usr/local/bin/chat-browser-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/chat-browser-entrypoint \
    && chmod 0755 /usr/local/bin/chat-browser-entrypoint

USER 1000:1000

# Container-network endpoints only. Deployment must not publish either port on the host.
EXPOSE 5900 9223

HEALTHCHECK --interval=15s --timeout=10s --start-period=60s --retries=3 \
    CMD ["/usr/local/bin/chat-browser-entrypoint", "--healthcheck"]

ENTRYPOINT ["/usr/local/bin/chat-browser-entrypoint"]
