#!/usr/bin/env bash
# Shared-library globals, callback names and quoted child-shell scripts.
# shellcheck disable=SC1091,SC2034,SC2329,SC2016
# Isolated fakes only. No provider login, logout or publish is executed.
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=publish-wizard.sh
source "$HERE/publish-wizard.sh"
load_library
ROOT=$(mktemp -d "$HERE/.wizard-test.XXXXXX")
test_cleanup() {
  local rc=$?
  if [[ "$rc" == 0 ]]; then rm -rf "$ROOT"; else echo "Test evidence retained at $ROOT" >&2; fi
}
trap test_cleanup EXIT
RUN="$ROOT/run"
WORK="$ROOT/work"
mkdir -p "$RUN" "$WORK"
say() { printf '%s\n' "$1"; }

expect_status() {
  local expected="$1" actual=0
  shift
  "$@" || actual=$?
  [[ "$actual" == "$expected" ]] || { echo "expected $expected, got $actual" >&2; exit 1; }
}

# Empty temporary config is private and removed on exit, including EOF/cancel.
prepare_config
[[ "$(stat -c %a "$CONFIG" 2>/dev/null || stat -f %Lp "$CONFIG")" == 600 ]]
old="$CONFIG"
cleanup_auth
[[ ! -e "$old" ]]

# No inherited npm auth override can survive silently.
expect_status 4 env 'npm_config_//registry.npmjs.org/:_authToken=synthetic-not-a-token' \
  bash -c 'source "$1"; load_library; isolate_npm' _ "$HERE/publish-wizard.sh"
expect_status 37 bash -c 'source "$1"; node(){ return 37; }; isolate_npm' _ "$HERE/publish-wizard.sh"

# Provider E401, not an empty config or network error, is required for revocation.
npm() {
  case "$1" in
    logout) return "${LOGOUT_STATUS:-0}" ;;
    whoami) printf '{"error":{"code":"%s"}}\n' "${PROBE_CODE:-E401}"; return 1 ;;
    *) echo 'Unexpected npm command' >&2; return 99 ;;
  esac
}
for mode in success network logout-failure already-revoked; do
  AUTH_ATTEMPTED=0
  prepare_config
  AUTH_ATTEMPTED=1
  printf '%s\n' "$CONFIG" > "$RUN/session.pending"
  old="$CONFIG"
  PROBE_CODE=E401 LOGOUT_STATUS=0
  if [[ "$mode" == network ]]; then PROBE_CODE=ECONNRESET; fi
  if [[ "$mode" == logout-failure ]]; then LOGOUT_STATUS=1; PROBE_CODE=ECONNRESET; fi
  if [[ "$mode" == already-revoked ]]; then LOGOUT_STATUS=1; fi
  if [[ "$mode" == success || "$mode" == already-revoked ]]; then
    expect_status 0 cleanup_auth
    [[ ! -e "$RUN/session.pending" ]]
  else
    expect_status 4 cleanup_auth
    [[ -f "$RUN/session.pending" ]]
  fi
  [[ ! -e "$old" ]]
  # Test-fixture reset only. Real unresolved obligations must be reconciled.
  rm -f "$RUN/session.pending"
done

# Failed cleanup followed by restart with missing evidence remains held.
printf '%s\n' "$RUN/npmrc.missing" > "$RUN/session.pending"
AUTH_ATTEMPTED=0
expect_status 4 prepare_config
[[ -f "$RUN/session.pending" ]]
rm "$RUN/session.pending"
AUTH_ATTEMPTED=0

# Registry parse and error semantics, and mismatch refusal, use synthetic data.
npm() {
  if [[ "$1" == view ]]; then
    case "$REGISTRY_MODE" in
      absent) echo 'npm error code E404' >&2; return 1 ;;
      unavailable) echo 'npm error code ECONNRESET' >&2; return 1 ;;
      present) cat "$ROOT/provider.json"; return 0 ;;
    esac
  fi
  echo 'No writes allowed in registry test' >&2
  return 99
}
REGISTRY_MODE=absent
expect_status 1 registry_read
REGISTRY_MODE=unavailable
expect_status 4 registry_read
printf 'synthetic archive\n' > "$RUN/package.tgz"
node -e 'const fs=require("fs"),c=require("crypto"),b=fs.readFileSync(process.argv[1]); const shasum=c.createHash("sha1").update(b).digest("hex"), integrity="sha512-"+c.createHash("sha512").update(b).digest("base64"); fs.writeFileSync(process.argv[2],JSON.stringify([{name:"@giggabit/agent-native-convex",version:"0.2.0",shasum,integrity}])); fs.writeFileSync(process.argv[3],JSON.stringify({version:"0.2.0","dist.shasum":shasum,"dist.integrity":integrity}))' "$RUN/package.tgz" "$RUN/pack.json" "$ROOT/provider.json"
hash_file "$RUN/package.tgz" > "$RUN/approved.sha1"
REGISTRY_MODE=present
expect_status 0 check_published
# Readback/receipt is tested with matching synthetic provider metadata only.
RECEIPT="$ROOT/receipt.txt"
git() { printf '%s\n' bbf6ab3d9f75c41972de4dfc342171eb398477ff; }
expect_status 0 perform_receipt
expect_status 0 check_receipt
unset -f git
printf 'tamper\n' >> "$RUN/package.tgz"
expect_status 4 check_published

# An intermediate typecheck failure must not run build, pack, login or publish.
# Use the real shared stage dispatcher to exercise its reconciliation branch.
(
  RUN="$ROOT/failure"
  mkdir -p "$RUN"
  WIZARD_STATE_FILE="$RUN/action.json"
  TOTAL_STAGES=1
  wizard_init 'test:1' 'fake-target' 'fake-digest'
  check_checkout() { return 0; }
  pnpm() {
    printf '%s\n' "$1" >> "$RUN/commands"
    [[ "$1" != typecheck ]]
  }
  npm() { echo 'unexpected npm effect' >> "$RUN/unexpected"; return 99; }
  printf 'retained archive\n' > "$RUN/package.tgz"
  printf 'old approval\n' > "$RUN/approved.sha1"
  wizard_stage build 'Fail typecheck' perform_build check_pack
  finish
) > "$ROOT/failure.log" 2>&1 && result=0 || result=$?
[[ "$result" == 4 ]]
[[ "$(cat "$ROOT/failure/commands")" == $'install\ntypecheck' ]]
[[ ! -e "$ROOT/failure/unexpected" && -f "$ROOT/failure/package.tgz" ]]
[[ ! -e "$ROOT/failure/approved.sha1" ]]
if grep -q 'Setup complete' "$ROOT/failure.log"; then exit 1; fi

# Real dispatcher exit semantics, cleanup, resume recheck, EOF and decline.
for mode in finish eof cancel hangup; do
  (
    RUN="$ROOT/$mode"
    mkdir -p "$RUN"
    WIZARD_STATE_FILE="$RUN/action.json"
    TOTAL_STAGES=1
    wizard_init "test-$mode:1" fake-target fake-digest
    AUTH_ATTEMPTED=0
    wizard_on_exit cleanup_auth
    trap publish_exit EXIT
    trap 'wizard_stop partial "Terminal closed"' HUP
    prepare_config
    printf '%s\n' "$CONFIG" > "$RUN/temp-path"
    if [[ "$mode" == hangup ]]; then
      AUTH_ATTEMPTED=1
      printf '%s\n' "$CONFIG" > "$RUN/session.pending"
      npm() {
        case "$1" in
          logout) kill -HUP "$BASHPID"; return 0 ;;
          whoami) printf '{"error":{"code":"E401"}}\n'; return 1 ;;
          *) return 99 ;;
        esac
      }
    fi
    perform() { touch "$RUN/effect"; }
    check() { [[ -f "$RUN/effect" ]]; }
    case "$mode" in
      finish|hangup) wizard_stage example Example perform check; finish ;;
      eof) pause </dev/null ;;
      cancel) confirm Required <<< n ;;
    esac
  ) > "$ROOT/$mode.log" 2>&1 && result=0 || result=$?
  case "$mode" in finish|hangup) [[ "$result" == 0 ]];; eof) [[ "$result" == 2 ]];; cancel) [[ "$result" == 3 ]];; esac
  [[ ! -e "$(cat "$ROOT/$mode/temp-path")" ]]
done
(
  RUN="$ROOT/finish"
  WIZARD_STATE_FILE="$RUN/action.json"
  TOTAL_STAGES=1
  wizard_init 'test-finish:1' fake-target fake-digest
  perform() { echo 'must not repeat'; return 99; }
  check() { [[ -f "$RUN/effect" ]]; }
  wizard_stage example Example perform check
  finish
) > "$ROOT/resume.log" 2>&1
if grep -q 'must not repeat' "$ROOT/resume.log"; then exit 1; fi
echo 'PASS: temp config, revocation, inherited config refusal, retained obligations, registry reconciliation, failure propagation, exit codes and resume'
