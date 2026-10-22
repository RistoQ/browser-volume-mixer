#!/usr/bin/env bash
#
# Sign the extension for self-distribution.
#
# Firefox only installs Mozilla-signed add-ons on the Release and Beta channels
# (the about:config override for unsigned ones exists only in Developer Edition,
# Nightly and ESR), so a signed .xpi is the only way to make this installable by
# a normal click.
#
# --channel=unlisted means AMO signs the file but publishes nothing: there is no
# AMO page and you distribute the .xpi yourself (see README, "Installing for
# real"). Review is automated and normally finishes in seconds, but every
# submission can still be looked at by a human at any time, so read
# https://extensionworkshop.com/documentation/publish/add-on-policies/ before
# submitting anything you would not want reviewed.
#
# One-time setup:
#   1. Free developer account: https://addons.mozilla.org/developers/
#   2. API credentials:       https://addons.mozilla.org/developers/addon/api/key/
#   3. Keep them out of the repository. Either export them in the shell, or
#      create ~/.amo.env (outside this repo) containing:
#
#        WEB_EXT_API_KEY='user:12345678:99'
#        WEB_EXT_API_SECRET='0123456789abcdef...'
#
#      or point AMO_ENV_FILE at a file elsewhere. Never commit those values;
#      CI supplies the same two from repository secrets.
#
# Usage:
#   tools/sign.sh [extra web-ext sign flags]
#
# The signed .xpi lands in web-ext-artifacts/ and is what you attach to a
# release (or let .github/workflows/release.yml do it on a version tag).
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${AMO_ENV_FILE:-$HOME/.amo.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

: "${WEB_EXT_API_KEY:?WEB_EXT_API_KEY is unset - see the setup comment at the top of this script}"
: "${WEB_EXT_API_SECRET:?WEB_EXT_API_SECRET is unset - see the setup comment at the top of this script}"

# Node reads the version so this works the same on the Windows host and in CI
# (the python here is `python`, the python there is `python3`).
version=$(node -p "require('./manifest.json').version")
echo "Signing version $version for the unlisted (self-distribution) channel..."

npx --yes web-ext sign \
  --channel=unlisted \
  --api-key="$WEB_EXT_API_KEY" \
  --api-secret="$WEB_EXT_API_SECRET" \
  "$@"

echo
echo "Signed add-on:"
ls -1 web-ext-artifacts/*.xpi
echo
echo "Next: python tools/make_updates.py --tag v$version --xpi <the .xpi above>"
