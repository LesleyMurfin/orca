FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    systemd systemd-sysv libpam-systemd dbus dbus-user-session procps util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 1001 --create-home --shell /bin/sh orca \
  && mkdir -p /run/user/1001 \
  && chown orca:orca /run/user/1001

COPY serve-fixture.cjs run-cases.cjs /opt/orca-serve-systemd/

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
