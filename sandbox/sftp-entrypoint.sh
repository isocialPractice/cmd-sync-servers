#!/bin/sh
# Creates the throwaway user and starts sshd with SFTP only.
set -eu

adduser -D -s /bin/sh -h "/home/$SANDBOX_USER" "$SANDBOX_USER"
printf '%s:%s\n' "$SANDBOX_USER" "$SANDBOX_PASSWORD" | chpasswd
mkdir -p "/home/$SANDBOX_USER/site"
chown "$SANDBOX_USER:$SANDBOX_USER" "/home/$SANDBOX_USER/site"

ssh-keygen -A
cat > /etc/ssh/sshd_config <<EOF
Port 22
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication yes
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $SANDBOX_USER
ForceCommand internal-sftp
Subsystem sftp internal-sftp
EOF

exec /usr/sbin/sshd -D -e
