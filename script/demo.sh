#!/usr/bin/env bash
# One command that runs the loop live and prints what happened.
#
#   ./script/demo.sh [samples]
#
# This exists to be watched. The harness is built for runs of dozens of
# samples and prints a line per sample; a demo wants the opposite - a couple
# of loops, and every hash on screen so a viewer can check the claim against
# the explorers themselves rather than take the number on trust.
#
# It adds no measurement of its own. It drives harness/collect.mjs and then
# reads the sample file it wrote, so what appears here is the same evidence
# the report is built from.

set -euo pipefail
cd "$(dirname "$0")/.."

SAMPLES="${1:-2}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "no .env -- copy .env.example and fill it in"
set -a; . ./.env; set +a

command -v cast >/dev/null || die "cast not on PATH (try: export PATH=\"\$HOME/.foundry/bin:\$PATH\")"
[ -f deployments/origin.json ] || die "no deployments/origin.json -- run ./script/deploy.sh first"
[ -f deployments/reactive.json ] || die "no deployments/reactive.json -- run ./script/deploy.sh first"

FEED="$(node -e "process.stdout.write(require('./deployments/origin.json').priceFeed)")"
EXECUTOR="$(node -e "process.stdout.write(require('./deployments/origin.json').executor)")"
REACTOR="$(node -e "process.stdout.write(require('./deployments/reactive.json').reactor)")"

say "The loop"
info "price feed   $FEED            Base Sepolia"
info "reactor      $REACTOR         Reactive Lasna"
info "executor     $EXECUTOR        Base Sepolia"

say "Funding"
info "reactor   $(cast to-unit "$(cast balance "$REACTOR" --rpc-url "$REACTIVE_RPC_URL")" ether) lREACT   pays for its own reactive transactions"
info "executor  $(cast to-unit "$(cast balance "$EXECUTOR" --rpc-url "$ORIGIN_RPC_URL")" ether) ETH      the proxy bills it for callbacks"

say "Pushing $SAMPLES price updates below the floor"
info "Each one should cross the floor, wake the reactor on Lasna, and come"
info "back as a callback on Base Sepolia."
echo
node harness/collect.mjs --samples "$SAMPLES" --pattern all-trigger --out results/demo-latest.json

say "What landed"
node -e '
const r = require("./results/demo-latest.json");
const ok = r.samples.filter((s) => s.execution && !s.failed);
if (ok.length === 0) {
  console.log("  No completed loops. The sample file says why.");
  process.exit(0);
}
for (const s of ok) {
  const blocks = s.execution.blockNumber - s.origin.blockNumber;
  console.log("");
  console.log("  seq " + s.seq + ": " + blocks + " origin blocks = " + (blocks * 0.2).toFixed(1) + "s end to end");
  console.log("    origin    https://sepolia.basescan.org/tx/" + s.origin.txHash);
  console.log("    reaction  https://lasna.reactscan.net/tx/" + s.reaction.txHash);
  console.log("    callback  https://sepolia.basescan.org/tx/" + s.execution.txHash);
}
console.log("");
console.log("  End to end is the execution block timestamp minus the origin");
console.log("  block timestamp. Both are Base Sepolia, so the clock offset");
console.log("  between the chains cancels exactly. The block count is the");
console.log("  finer measure: timestamps are whole seconds, blocks are 200ms.");
'

say "Full report"
info "node harness/report.mjs results/demo-latest.json"
info ""
info "The sixty-sample run this project reports on is in"
info "results/samples-latest.json, which a demo run does not touch."
