# OpenSSH serving SFTP to one throwaway user, for the interop tests only.
FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

RUN apk add --no-cache openssh-server

COPY sftp-entrypoint.sh /usr/local/bin/sandbox-entrypoint
RUN chmod 0755 /usr/local/bin/sandbox-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
