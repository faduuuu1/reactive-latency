#!/usr/bin/env bash
# Deploys the whole loop, in the one order that works.
#
#   ./script/deploy.sh
#
# The ordering is not a preference. The executor's authorised sender and the
# reactor's executor address are both immutable, so each constructor wants the
# other's address. The way out is that a CREATE address depends only on the
# deployer and its nonce, never on the constructor arguments -- so the
# reactor's address on Lasna can be computed before anything exists, handed to
# the executor, and then checked when the reactor is really deployed.
#
# The executor goes first because the reactor subscribes inside its
# constructor. From the instant it exists it receives events and pays for
# them, so it must be the last thing deployed: an executor waiting for a
# reactor costs nothing, a reactor firing at an address with no code burns
# funds and reports success.

set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "no .env -- copy .env.example and fill it in"
set -a; . ./.env; set +a

command -v forge >/dev/null || die "forge not on PATH (try: export PATH=\"\$HOME/.foundry/bin:\$PATH\")"
command -v cast  >/dev/null || die "cast not on PATH"

: "${ORIGIN_RPC_URL:?set in .env}"
: "${REACTIVE_RPC_URL:?set in .env}"
: "${ORIGIN_CHAIN_ID:?set in .env}"
: "${REACTIVE_CHAIN_ID:?set in .env}"
: "${CALLBACK_PROXY:?set in .env}"
: "${FLOOR_WEI:?set in .env}"

EXECUTOR_FUNDING_WEI="${EXECUTOR_FUNDING_WEI:-5000000000000000}"   # 0.005 ETH
REACTOR_FUNDING_WEI="${REACTOR_FUNDING_WEI:-5000000000000000000}"  # 5 lREACT
DESTINATION_CHAIN_ID="${DESTINATION_CHAIN_ID:-$ORIGIN_CHAIN_ID}"

# Signing: a keystore keeps the key out of every command line on this machine.
if [ -n "${ETH_KEYSTORE_ACCOUNT:-}" ]; then
  SIGNER=(--account "$ETH_KEYSTORE_ACCOUNT")
  DEPLOYER="$(cast wallet address --account "$ETH_KEYSTORE_ACCOUNT")"
else
  : "${PRIVATE_KEY:?set PRIVATE_KEY in .env, or use a keystore via ETH_KEYSTORE_ACCOUNT}"
  SIGNER=(--private-key "$PRIVATE_KEY")
  DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
fi

say "Preflight"
info "deployer  $DEPLOYER"

ORIGIN_SEEN="$(cast chain-id --rpc-url "$ORIGIN_RPC_URL")"
LASNA_SEEN="$(cast chain-id --rpc-url "$REACTIVE_RPC_URL")"
[ "$ORIGIN_SEEN" = "$ORIGIN_CHAIN_ID" ] \
  || die "ORIGIN_RPC_URL serves chain $ORIGIN_SEEN, .env says $ORIGIN_CHAIN_ID"
[ "$LASNA_SEEN" = "$REACTIVE_CHAIN_ID" ] \
  || die "REACTIVE_RPC_URL serves chain $LASNA_SEEN, .env says $REACTIVE_CHAIN_ID"
info "origin    chain $ORIGIN_SEEN"
info "reactive  chain $LASNA_SEEN"

ORIGIN_BAL="$(cast balance "$DEPLOYER" --rpc-url "$ORIGIN_RPC_URL")"
LASNA_BAL="$(cast balance "$DEPLOYER" --rpc-url "$REACTIVE_RPC_URL")"
info "origin    balance $(cast to-unit "$ORIGIN_BAL" ether) ETH"
info "reactive  balance $(cast to-unit "$LASNA_BAL" ether) lREACT"

# Wei does not fit in the 64-bit integers the shell compares with, and a
# silently-wrong comparison here would wave through an underfunded deploy.
lt()   { A="$1" B="$2" node -e 'process.exit(BigInt(process.env.A) < BigInt(process.env.B) ? 0 : 1)'; }
plus() { A="$1" B="$2" node -e 'process.stdout.write((BigInt(process.env.A) + BigInt(process.env.B)).toString())'; }

# Deploying both contracts, funding the executor, and a margin for the pushes
# the harness will send afterwards.
NEED_ORIGIN="$(plus "$EXECUTOR_FUNDING_WEI" 500000000000000)"
if lt "$ORIGIN_BAL" "$NEED_ORIGIN"; then
  die "origin balance $(cast to-unit "$ORIGIN_BAL" ether) ETH is below the ~$(cast to-unit "$NEED_ORIGIN" ether) ETH needed to deploy, fund the executor and run the harness"
fi
if lt "$LASNA_BAL" "$REACTOR_FUNDING_WEI"; then
  die "reactive balance $(cast to-unit "$LASNA_BAL" ether) lREACT is below the $(cast to-unit "$REACTOR_FUNDING_WEI" ether) the reactor needs. Buy some: ./script/buy-lreact.sh 0.1"
fi

PROXY_CODE="$(cast code "$CALLBACK_PROXY" --rpc-url "$ORIGIN_RPC_URL")"
[ "$PROXY_CODE" != "0x" ] \
  || die "CALLBACK_PROXY $CALLBACK_PROXY has no code on chain $ORIGIN_SEEN -- wrong network's proxy address?"
info "proxy     $CALLBACK_PROXY (has code)"

say "Predicting the reactor's address on Lasna"
LASNA_NONCE="$(cast nonce "$DEPLOYER" --rpc-url "$REACTIVE_RPC_URL")"
EXPECTED_REACTOR="$(cast compute-address "$DEPLOYER" --nonce "$LASNA_NONCE" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)"
[ -n "$EXPECTED_REACTOR" ] || die "could not compute the reactor address"
info "lasna nonce $LASNA_NONCE"
info "reactor will be $EXPECTED_REACTOR"
info ""
info "Send nothing else from this account on Lasna until step 2 finishes."
info "Another transaction there moves the nonce, the address changes, and the"
info "executor ends up authorising a contract that will never exist. The"
info "reactive deploy asserts the match, so that mistake fails loudly rather"
info "than silently -- but it still costs the executor deploy."

say "1/2  Origin chain: PriceFeed and StopLossExecutor"
EXPECTED_REACTOR="$EXPECTED_REACTOR" \
EXECUTOR_FUNDING_WEI="$EXECUTOR_FUNDING_WEI" \
forge script script/DeployOrigin.s.sol:DeployOrigin \
  --rpc-url "$ORIGIN_RPC_URL" \
  --broadcast \
  --sender "$DEPLOYER" \
  "${SIGNER[@]}" \
  ${ORIGIN_FORGE_ARGS:-}

ORIGIN_FEED="$(node -e "process.stdout.write(require('./deployments/origin.json').priceFeed)")"
EXECUTOR="$(node -e "process.stdout.write(require('./deployments/origin.json').executor)")"
info "feed     $ORIGIN_FEED"
info "executor $EXECUTOR"

[ "$(cast code "$EXECUTOR" --rpc-url "$ORIGIN_RPC_URL")" != "0x" ] || die "executor has no code"

say "2/2  Reactive Lasna: StopLossReactor"
# If this fails on transaction type, Lasna may want legacy transactions:
#   REACTIVE_FORGE_ARGS=--legacy ./script/deploy.sh
EXPECTED_REACTOR="$EXPECTED_REACTOR" \
ORIGIN_FEED="$ORIGIN_FEED" \
EXECUTOR="$EXECUTOR" \
ORIGIN_CHAIN_ID="$ORIGIN_CHAIN_ID" \
DESTINATION_CHAIN_ID="$DESTINATION_CHAIN_ID" \
FLOOR_WEI="$FLOOR_WEI" \
REACTOR_FUNDING_WEI="$REACTOR_FUNDING_WEI" \
forge script script/DeployReactive.s.sol:DeployReactive \
  --rpc-url "$REACTIVE_RPC_URL" \
  --broadcast \
  --sender "$DEPLOYER" \
  "${SIGNER[@]}" \
  ${REACTIVE_FORGE_ARGS:-}

REACTOR="$(node -e "process.stdout.write(require('./deployments/reactive.json').reactor)")"
[ "$(cast code "$REACTOR" --rpc-url "$REACTIVE_RPC_URL")" != "0x" ] || die "reactor has no code"
[ "$(printf '%s' "$REACTOR" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$EXPECTED_REACTOR" | tr 'A-Z' 'a-z')" ] \
  || die "reactor deployed to $REACTOR but the executor authorises $EXPECTED_REACTOR"

say "Deployed"
info "feed      $ORIGIN_FEED      (chain $ORIGIN_CHAIN_ID)"
info "executor  $EXECUTOR      (chain $ORIGIN_CHAIN_ID)"
info "reactor   $REACTOR      (chain $REACTIVE_CHAIN_ID)"
info ""
info "Measure it:  node harness/collect.mjs --samples 40"
info "Report it:   node harness/report.mjs results/samples-latest.json"
