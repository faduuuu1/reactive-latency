#!/usr/bin/env bash
# Buys testnet lREACT by sending Base Sepolia ETH to the Reactive faucet.
#
#   ./script/buy-lreact.sh 0.1      # 0.1 ETH in, ~10 lREACT out
#
# The rate is 1 ETH to 100 lREACT. The ETH goes out on the origin chain and
# the lREACT arrives on Lasna, which is why this account needs Base Sepolia
# funds twice over: once here, and again to fund the executor and pay for the
# harness's pushes.

set -euo pipefail
cd "$(dirname "$0")/.."

die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "no .env -- copy .env.example and fill it in"
set -a; . ./.env; set +a

AMOUNT="${1:-}"
[ -n "$AMOUNT" ] || die "usage: ./script/buy-lreact.sh <eth-amount>   e.g. 0.1"

# Rejected, not warned about. The faucet keeps anything above five ether
# instead of refunding it, so one extra zero here is unrecoverable.
# `if` rather than `cmd && die`, because under `set -e` the latter aborts the
# script on the ordinary case where the check passes.
# The value goes through the environment rather than argv: `node -e ... -1`
# treats the argument as a node flag and dies with "bad option", which would
# turn a rejected negative amount into a confusing crash.
if ! AMOUNT="$AMOUNT" node -e 'const n = Number(process.env.AMOUNT); process.exit(Number.isFinite(n) && n > 0 ? 0 : 1)'; then
  die "amount must be a positive number of ether, got '$AMOUNT'"
fi
if AMOUNT="$AMOUNT" node -e 'process.exit(Number(process.env.AMOUNT) > 5 ? 0 : 1)'; then
  die "$AMOUNT ETH is over the 5 ETH cap -- the faucet keeps the excess, it is not refunded"
fi

FAUCET="${REACTIVE_FAUCET:-0x2afaFD298b23b62760711756088F75B7409f5967}"
: "${ORIGIN_RPC_URL:?set in .env}"
: "${REACTIVE_RPC_URL:?set in .env}"

if [ -n "${ETH_KEYSTORE_ACCOUNT:-}" ]; then
  SIGNER=(--account "$ETH_KEYSTORE_ACCOUNT")
  WALLET="$(cast wallet address --account "$ETH_KEYSTORE_ACCOUNT")"
else
  : "${PRIVATE_KEY:?set PRIVATE_KEY in .env}"
  SIGNER=(--private-key "$PRIVATE_KEY")
  WALLET="$(cast wallet address --private-key "$PRIVATE_KEY")"
fi

BEFORE="$(cast balance "$WALLET" --rpc-url "$REACTIVE_RPC_URL")"
echo "wallet        $WALLET"
echo "lREACT before $(cast to-unit "$BEFORE" ether)"
echo "sending       $AMOUNT ETH to the faucet at $FAUCET"

cast send "$FAUCET" "request(address)" "$WALLET" \
  --value "${AMOUNT}ether" \
  --rpc-url "$ORIGIN_RPC_URL" \
  "${SIGNER[@]}"

echo
echo "Sent. The lREACT arrives on Lasna a moment later; check with:"
echo "  cast balance $WALLET --rpc-url \"\$REACTIVE_RPC_URL\" | xargs cast to-unit"
