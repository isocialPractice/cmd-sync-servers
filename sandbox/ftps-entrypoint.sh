#!/bin/sh
# Creates the throwaway user and starts vsftpd with TLS required for logins
# and data, using the certificate mounted at /etc/sandbox-tls.
set -eu

adduser -D -s /bin/sh -h "/home/$SANDBOX_USER" "$SANDBOX_USER"
printf '%s:%s\n' "$SANDBOX_USER" "$SANDBOX_PASSWORD" | chpasswd
mkdir -p "/home/$SANDBOX_USER/site"
chown "$SANDBOX_USER:$SANDBOX_USER" "/home/$SANDBOX_USER/site"
grep -qx /bin/sh /etc/shells || echo /bin/sh >> /etc/shells

cat > /etc/vsftpd/vsftpd.conf <<EOF
listen=YES
background=NO
seccomp_sandbox=NO
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=022
chroot_local_user=YES
allow_writeable_chroot=YES
utf8_filesystem=YES
pasv_enable=YES
pasv_address=127.0.0.1
pasv_min_port=21100
pasv_max_port=21110
ssl_enable=YES
force_local_logins_ssl=YES
force_local_data_ssl=YES
require_ssl_reuse=YES
ssl_ciphers=HIGH
rsa_cert_file=/etc/sandbox-tls/cert.pem
rsa_private_key_file=/etc/sandbox-tls/key.pem
EOF

exec /usr/sbin/vsftpd /etc/vsftpd/vsftpd.conf
