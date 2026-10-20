#!/bin/sh
# Install a fixed PHP CLI extension set from the Sury Debian packages instead of compiling
# extensions with docker-php-ext-install. Sury publishes prebuilt packages for bookworm and trixie.
set -eu

distro=${1:?usage: install-php.sh <debian-codename> <php-version>}
version=${2:?usage: install-php.sh <debian-codename> <php-version>}
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://packages.sury.org/php/apt.gpg -o /etc/apt/keyrings/sury-php.gpg
chmod 0644 /etc/apt/keyrings/sury-php.gpg
printf 'deb [signed-by=/etc/apt/keyrings/sury-php.gpg] https://packages.sury.org/php/ %s main\n' \
  "$distro" > /etc/apt/sources.list.d/sury-php.list
apt-get update
apt-get install -y --no-install-recommends \
  "php${version}-cli" \
  "php${version}-bcmath" \
  "php${version}-curl" \
  "php${version}-gd" \
  "php${version}-intl" \
  "php${version}-mbstring" \
  "php${version}-mysql" \
  "php${version}-pgsql" \
  "php${version}-sqlite3" \
  "php${version}-xml" \
  "php${version}-zip"
ln -sf "/usr/bin/php${version}" /usr/local/bin/php
rm -rf /var/lib/apt/lists/*

php -v
php -m | grep -E '^(bcmath|curl|gd|intl|mbstring|pdo_mysql|pdo_pgsql|pdo_sqlite|zip)$'
