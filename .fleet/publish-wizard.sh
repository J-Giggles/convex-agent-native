#!/usr/bin/env bash
# Library globals and JavaScript template strings are intentional.
# shellcheck disable=SC2034,SC2016
# Owner-run npm release. Provider contracts:
# https://docs.npmjs.com/cli/v11/commands/npm-login
# https://docs.npmjs.com/cli/v11/commands/npm-logout
# https://docs.npmjs.com/generating-provenance-statements
set -euo pipefail
set +x
set +v
set +a

PACKAGE='@giggabit/agent-native-convex'
VERSION=0.2.0
COMMIT=bbf6ab3d9f75
REPO=/home/jgigg/code/projects/convex-agent-native
WORK="$REPO/.worktrees/npm-publish-0.2.0"
RUN="$HOME/.local/state/fleet-wizard/agent-native-convex-0.2.0"
RECEIPT="$HOME/.local/state/fleet-agent-handoffs/valgrind-mac/agent-native-convex-0.2.0-publish-receipt-20261022.md"
REGISTRY=https://registry.npmjs.org
CONFIG=''
AUTH_ATTEMPTED=0
PREFLIGHT_FAILED=0
BUILD_FAILED=0

# This file is sourceable by focused tests. Sourcing never starts a stage.
load_library() {
  local root="${FLEET_ROOT:-$HOME/code/giggabit-fleet}"
  # shellcheck source=/dev/null
  source "$root/skills/universal/wizard/library.sh" || return $?
}

# Preserve the original status for the shared exit handler while suppressing
# terminal hangups during credential revocation. INT/TERM are masked by it.
return_status() { return "$1"; }
publish_exit() {
  local code=$?
  trap '' HUP
  if return_status "$code"; then _wizard_exit; else _wizard_exit; fi
}

hash_file() { sha1sum "$1" | cut -d ' ' -f 1; }

# Web login creates nonportable provider state in the approved host's temporary
# userconfig. Never capture a token, copy it to Pass, or print npm config.
cleanup_auth() {
  local failed=0 revoke='' result=0
  if [[ "$AUTH_ATTEMPTED" == 1 ]]; then
    if [[ -n "$CONFIG" && -f "$CONFIG" ]]; then
      # Logout removes local credentials. Use a second 0600 temporary context
      # for logout, then probe the ORIGINAL credential against the provider.
      revoke=$(mktemp "$RUN/revoke.XXXXXX") || failed=1
      if [[ -n "$revoke" ]]; then
        chmod 600 "$revoke" || failed=1
        cat "$CONFIG" > "$revoke" || failed=1
        # A previous interrupted logout may already have revoked this session.
        # Its current remote E401 probe is authoritative even if logout retries fail.
        NPM_CONFIG_USERCONFIG="$revoke" npm logout --registry "$REGISTRY" >/dev/null 2>&1 || :
        if npm whoami --json --registry "$REGISTRY" > "$RUN/revocation-probe.json" 2>/dev/null; then
          failed=1
        else
          # ENEEDAUTH is local, not independent revocation evidence. Only a
          # provider E401 proves that the retained original token is invalid.
          node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])); if(d.error?.code!=="E401") process.exit(4)' "$RUN/revocation-probe.json" >/dev/null 2>&1 || failed=1
        fi
        rm -f -- "$revoke" || failed=1
      fi
    else
      failed=1
    fi
    if [[ "$failed" == 0 ]]; then rm -f "$RUN/session.pending" || failed=1; fi
  fi
  if [[ -n "$CONFIG" ]]; then
    rm -f -- "$CONFIG" || failed=1
    [[ ! -e "$CONFIG" ]] || failed=1
  fi
  if [[ "$failed" != 0 ]]; then
    say 'Revocation is unverified. Revoke the npm session from this run through npm account settings. The nonsecret session.pending obligation remains; resume is held for reconciliation.'
    result=4
  fi
  return "$result"
}

isolate_npm() {
  local key keys
  keys=$(node -e 'for(const k of Object.keys(process.env)) console.log(k)') || return $?
  # Remove ALL inherited npm settings, including registry-scoped auth keys
  # whose names cannot be passed to Bash unset. No values enter shell argv.
  while IFS= read -r key; do
    case "$key" in
      [Nn][Pp][Mm]_[Cc][Oo][Nn][Ff][Ii][Gg]_*|NPM_TOKEN|NODE_AUTH_TOKEN)
        if [[ "$key" =~ ^[a-zA-Z_][a-zA-Z_0-9]*$ ]]; then
          unset "$key" || return $?
        else
          say 'Refusing an inherited npm environment key with a non-shell name. Start a clean login shell.'
          return 4
        fi ;;
    esac
  done <<< "$keys"
  export NPM_CONFIG_GLOBALCONFIG=/dev/null
  export NPM_CONFIG_REGISTRY="$REGISTRY"
  # No npm debug/timing files may retain authentication response details.
  export NPM_CONFIG_LOGS_MAX=0
}

prepare_config() {
  local stale
  isolate_npm || return $?
  # A killed process cannot run traps. Reconcile its nonsecret obligation and
  # retained private config before creating another session. Missing evidence
  # holds the action rather than silently forgetting the session.
  if [[ -f "$RUN/session.pending" ]]; then
    IFS= read -r CONFIG < "$RUN/session.pending" || return 4
    [[ "$CONFIG" == "$RUN"/npmrc.* && "$CONFIG" != *'/../'* && ! -L "$CONFIG" ]] || return 4
    AUTH_ATTEMPTED=1
    export NPM_CONFIG_USERCONFIG="$CONFIG"
    cleanup_auth || return 4
    AUTH_ATTEMPTED=0
  fi
  # These are either empty pre-login files or copies of the now-revoked
  # session. The pending obligation above must reconcile before their removal.
  for stale in "$RUN"/npmrc.* "$RUN"/revoke.*; do
    [[ -e "$stale" || -L "$stale" ]] || continue
    [[ -f "$stale" && ! -L "$stale" && -O "$stale" ]] || return 4
    rm -f -- "$stale" || return $?
  done
  CONFIG=$(mktemp "$RUN/npmrc.XXXXXX") || return $?
  chmod 600 "$CONFIG" || return $?
  export NPM_CONFIG_USERCONFIG="$CONFIG"
}

# Only a documented E404 means absent. Network/auth/parse failures are unknown.
registry_read() {
  local result
  if npm view "$PACKAGE@$VERSION" dist.integrity dist.shasum version --json \
    --registry "$REGISTRY" > "$RUN/registry.json" 2> "$RUN/registry-error"; then
    node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1])); if(d.version!=="0.2.0" || !/^sha512-/.test(d["dist.integrity"]) || !/^[a-f0-9]{40}$/.test(d["dist.shasum"])) process.exit(4)' "$RUN/registry.json" || return 4
    return 0
  else
    result=$?
    if [[ "$result" != 0 ]] && grep -q 'E404' "$RUN/registry-error"; then return 1; fi
    return 4
  fi
}

check_checkout() {
  local actual expected dirty
  [[ -d "$WORK" ]] || return 1
  expected=$(git -C "$REPO" rev-parse "$COMMIT^{commit}") || return 4
  actual=$(git -C "$WORK" rev-parse HEAD) || return 4
  [[ "$actual" == "$expected" ]] || return 4
  if git -C "$WORK" symbolic-ref -q HEAD >/dev/null; then return 4; fi
  dirty=$(git -C "$WORK" status --porcelain --untracked-files=all) || return 4
  [[ -z "$dirty" && ! -e "$WORK/.npmrc" ]] || return 4
  node -e 'const p=require(process.argv[1]); if(p.name!=="@giggabit/agent-native-convex" || p.version!=="0.2.0" || p.private) process.exit(4)' "$WORK/package.json" || return 4
  return 0
}

check_preflight() {
  local status intent remote
  [[ "$PREFLIGHT_FAILED" == 0 ]] || return 4
  remote=$(git -C "$REPO" remote get-url origin) || return 4
  [[ "$remote" == git@github.com:J-Giggles/convex-agent-native.git || "$remote" == https://github.com/J-Giggles/convex-agent-native.git ]] || return 4
  git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main || return 4
  check_checkout || return $?
  if registry_read; then
    # A resumed publish intent may have succeeded before interruption. Never
    # republish: require the retained, approved archive to match the registry.
    intent=$(_wizard_state get --stage publish) || return 4
    [[ "$intent" != pending ]] || return 4
    check_pack || return 4
    check_published || return 4
    return 0
  else
    status=$?
    [[ "$status" == 1 ]] || return 4
  fi
  return 0
}

perform_preflight() {
  local remote
  PREFLIGHT_FAILED=1
  remote=$(git -C "$REPO" remote get-url origin) || return $?
  [[ "$remote" == git@github.com:J-Giggles/convex-agent-native.git || "$remote" == https://github.com/J-Giggles/convex-agent-native.git ]] || return 4
  git -C "$REPO" fetch origin main || return $?
  git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main || return 4
  if [[ ! -d "$WORK" ]]; then
    git -C "$REPO" worktree add --detach "$WORK" "$COMMIT" || return $?
  fi
  PREFLIGHT_FAILED=0
  check_preflight || return $?
}

check_pack() {
  [[ "$BUILD_FAILED" == 0 ]] || return 4
  [[ -f "$RUN/approved.sha1" && -f "$RUN/package.tgz" ]] || return 1
  local actual approved
  actual=$(hash_file "$RUN/package.tgz") || return 4
  approved=$(cat "$RUN/approved.sha1") || return 4
  [[ "$actual" == "$approved" ]] || return 4
  node -e 'const fs=require("fs"),c=require("crypto"); const p=JSON.parse(fs.readFileSync(process.argv[1]))[0]; const b=fs.readFileSync(process.argv[2]); if(p.name!=="@giggabit/agent-native-convex" || p.version!=="0.2.0" || p.shasum!==c.createHash("sha1").update(b).digest("hex") || p.integrity!=="sha512-"+c.createHash("sha512").update(b).digest("base64")) process.exit(4)' "$RUN/pack.json" "$RUN/package.tgz" || return 4
  return 0
}

perform_build() {
  BUILD_FAILED=1
  rm -f "$RUN/approved.sha1" || return $?
  check_checkout || return $?
  cd "$WORK" || return $?
  pnpm install --frozen-lockfile || return $?
  pnpm typecheck || return $?
  pnpm build || return $?
  pnpm test || return $?
  pnpm test:guardrails || return $?
  pnpm release:verify || return $?
  npm pack --dry-run || return $?
  npm pack --ignore-scripts --json --pack-destination "$RUN" > "$RUN/pack.json" || return $?
  mv "$RUN/giggabit-agent-native-convex-0.2.0.tgz" "$RUN/package.tgz" || return $?
  node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]))[0]; for(const f of p.files) console.log(`${f.size}\t${f.path}`); console.log(`Packed bytes: ${p.size}; unpacked bytes: ${p.unpackedSize}`)' "$RUN/pack.json" || return $?
  confirm 'Human judgement: are these files and package sizes suitable for public release?' || return $?
  hash_file "$RUN/package.tgz" > "$RUN/approved.sha1" || return $?
  BUILD_FAILED=0
  check_pack || return $?
}

check_auth() {
  npm whoami --registry "$REGISTRY" >/dev/null 2>&1 || return 1
  return 0
}
perform_auth() {
  printf '%s\n' "$CONFIG" > "$RUN/session.pending" || return $?
  AUTH_ATTEMPTED=1
  say 'Jordan: use your npm account with publish rights for @giggabit. npm handles web sign-in and any OTP. This temporary session is revoked on exit.'
  npm login --auth-type=web --registry "$REGISTRY" || return $?
  npm whoami --registry "$REGISTRY" || return $?
}

check_published() {
  local result
  if registry_read; then
    check_pack || return 4
    node -e 'const fs=require("fs"),d=JSON.parse(fs.readFileSync(process.argv[1])),p=JSON.parse(fs.readFileSync(process.argv[2]))[0]; if(d["dist.shasum"]!==p.shasum || d["dist.integrity"]!==p.integrity) process.exit(4)' "$RUN/registry.json" "$RUN/pack.json" || return 4
    return 0
  else
    result=$?
    return "$result"
  fi
}
perform_publish() {
  local status
  # Reconcile before every mutation, including a fresh journal.
  if check_published; then return 0; else status=$?; fi
  [[ "$status" == 1 ]] || return 4
  check_pack || return $?
  check_auth || return $?
  cd "$WORK" || return $?
  # The exact approved tarball is published, not a freshly rebuilt directory.
  # giggabit-server tmux has no supported CI OIDC provider. Omit provenance.
  say 'Publishing the approved tarball publicly. Provenance omitted: this tmux host has no supported CI OIDC provider.'
  npm publish "$RUN/package.tgz" --access public --registry "$REGISTRY" || return $?
  check_published || return $?
}

render_receipt() {
  local full time
  full=$(git -C "$WORK" rev-parse HEAD) || return $?
  time=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return $?
  node -e 'const fs=require("fs"),d=JSON.parse(fs.readFileSync(process.argv[1])); console.log(`# npm publish receipt\n\nPackage: @giggabit/agent-native-convex\nVersion: ${d.version}\nIntegrity: ${d["dist.integrity"]}\nTarball shasum: ${d["dist.shasum"]}\nCommit: ${process.argv[2]}\nVerified at: ${process.argv[3]}\nHost: giggabit-server\n`)' "$RUN/registry.json" "$full" "$time" || return $?
}
check_receipt() {
  local full
  check_published || return $?
  [[ -f "$RECEIPT" ]] || return 1
  full=$(git -C "$WORK" rev-parse HEAD) || return 4
  node -e 'const fs=require("fs"),d=JSON.parse(fs.readFileSync(process.argv[1])),s=fs.readFileSync(process.argv[2],"utf8"); for(const v of ["Version: 0.2.0",`Integrity: ${d["dist.integrity"]}`,`Tarball shasum: ${d["dist.shasum"]}`,`Commit: ${process.argv[3]}`,"Verified at:"]) if(!s.includes(v)) process.exit(4)' "$RUN/registry.json" "$RECEIPT" "$full" || return 4
  cat "$RECEIPT" || return $?
}
perform_receipt() {
  check_published || return $?
  mkdir -p "$(dirname "$RECEIPT")" || return $?
  render_receipt > "$RUN/receipt.tmp" || return $?
  mv "$RUN/receipt.tmp" "$RECEIPT" || return $?
  check_receipt || return $?
}

main() {
  [[ "$(hostname -s)" == giggabit-server ]] || { printf '%s\n' 'Run only on giggabit-server.' >&2; return 2; }
  node -e 'if(![22,24,26].includes(+process.versions.node.split(".")[0])) process.exit(2)' || { printf '%s\n' 'Use a checked Node 22, 24 or 26 runtime.' >&2; return 2; }
  load_library || return $?
  mkdir -p "$RUN" || return $?
  [[ ! -L "$RUN" && -O "$RUN" ]] || return 4
  chmod 700 "$RUN" || return $?
  TOTAL_STAGES=5
  WIZARD_STATE_FILE="$RUN/action.json"
  local digest
  digest=$(sha256sum "${BASH_SOURCE[0]}" | cut -d ' ' -f 1) || return $?
  wizard_init 'agent-native-convex-publish:revision-1' 'giggabit-server/J-Giggles/convex-agent-native/@giggabit/agent-native-convex@0.2.0/bbf6ab3d9f75' "$digest"
  wizard_on_exit cleanup_auth
  trap publish_exit EXIT
  trap 'wizard_stop partial "The wizard terminal closed."' HUP
  cd "$RUN" || wizard_stop failed 'Could not enter the controlled npm configuration directory.'
  prepare_config || wizard_stop failed 'Could not prepare the private temporary npm config. An unresolved session must be reconciled before another login.'
  banner 'Jordan: publish @giggabit/agent-native-convex 0.2.0 to public npm from giggabit-server'
  say 'Stages: detached preflight; build/test/package approval; temporary web login; public publish; registry readback and receipt.'
  say 'Resume with the same command. Saved stages are rechecked. Do not delete the journal or archive after an uncertain publish.'
  wizard_stage preflight 'Verify detached checkout and registry' perform_preflight check_preflight
  wizard_stage build 'Build, test and approve the archive' perform_build check_pack
  wizard_stage auth 'Temporary npm web login' perform_auth check_auth
  wizard_stage publish 'Publish the approved archive' perform_publish check_published
  wizard_stage readback 'Read back registry hashes and write receipt' perform_receipt check_receipt
  finish
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
