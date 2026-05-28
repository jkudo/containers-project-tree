#!/usr/bin/env bash
# Re-exec under bash if launched with sh/dash — this script needs pipefail,
# [[ ]], <<< and $'...'. (Inside the container `sh` is dash, hence the guard.)
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

# NoShareEnv firewall verifier — run INSIDE a dev container
# ---------------------------------------------------------
# Confirms that the in-container iptables/ipset egress allowlist is in effect.
# Because it runs in the container's own network namespace, it works the same on
# WSL docker-ce and Docker Desktop — the engine/backend is irrelevant from here.
#
# Run it from a terminal inside the container:
#     bash verify-firewall.sh        (or: sh verify-firewall.sh — it re-execs bash)
#
# Or feed it from the HOST without copying the file in:
#     docker exec -u 0 <container> bash -s < verify-firewall.sh
#     wsl.exe -d <distro> docker exec -u 0 <container> bash -s < verify-firewall.sh
#
# Exit code: 0 = all checks passed, 1 = at least one FAIL.

set -uo pipefail

if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'; else G= R= Y= B= N=; fi
pass=0; fail=0
ok()   { echo "  ${G}PASS${N} $*"; pass=$((pass+1)); }
bad()  { echo "  ${R}FAIL${N} $*"; fail=$((fail+1)); }
warn() { echo "  ${Y}WARN${N} $*"; }
hdr()  { echo; echo "${B}== $* ==${N}"; }

# iptables/ipset inspection needs root. The NoShareEnv container only grants
# passwordless sudo for init-firewall.sh, so `sudo iptables` may prompt for a
# password — we never want that. Use root directly if we are root, else use
# `sudo -n` ONLY if it is non-interactive; otherwise mark privileged inspection
# unavailable and skip it (the functional egress tests below need no root).
if [ "$(id -u)" = 0 ]; then
  SUDO=; PRIV_OK=1
elif sudo -n true 2>/dev/null; then
  SUDO="sudo -n"; PRIV_OK=1
else
  SUDO=; PRIV_OK=0
fi
priv() { $SUDO "$@"; }

# connects URL -> 0 if a TCP/TLS connection was established (any HTTP status),
# 1 if blocked (REJECT -> refused, or DROP -> timeout). http_code "000" means no
# HTTP response was received, i.e. the connection did not succeed. We do NOT use
# `curl -f`, so an HTTP 401/403/404 still counts as "connected" (= allowed).
connects() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 6 --max-time 12 "$1" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

echo "${B}NoShareEnv firewall verifier${N}  (in-container; host=$(hostname), user=$(id -un))"

HOST_HINT=$([ "${HOSTNAME:-}" ] && echo "<container>")
priv_skip() {  # explain how to see what we skipped, from the host (root, no sudo)
  warn "$1 skipped — no passwordless root for inspection as $(id -un)."
  warn "  see it from the HOST (root, no password):  docker exec -u 0 ${HOST_HINT:-<container>} $2"
  warn "  (the functional egress tests below prove enforcement without needing root)"
}

# ---- 1. iptables ruleset (needs root to read) ------------------------------
hdr "iptables ruleset (-S)"
if [ "$PRIV_OK" = 1 ]; then
  if rules=$(priv iptables -S 2>&1); then
    echo "$rules" | sed 's/^/    /'
    out_pol=$(awk '/^-P OUTPUT/{print $3}'  <<<"$rules")
    in_pol=$( awk '/^-P INPUT/{print $3}'   <<<"$rules")
    fwd_pol=$(awk '/^-P FORWARD/{print $3}' <<<"$rules")
    ok "iptables readable (NET_ADMIN present)"
    [ "$out_pol" = DROP ] && ok "OUTPUT policy = DROP (egress closed by default)" || bad "OUTPUT policy = ${out_pol:-?} (expected DROP)"
    [ "$in_pol"  = DROP ] && ok "INPUT policy = DROP (ingress closed by default)"  || warn "INPUT policy = ${in_pol:-?} (expected DROP)"
    [ "$fwd_pol" = DROP ] && ok "FORWARD policy = DROP"                            || warn "FORWARD policy = ${fwd_pol:-?}"
    grep -q 'match-set allowed-domains' <<<"$rules" && ok "allowlist rule present (-m set --match-set allowed-domains dst)" || bad "no allowlist OUTPUT rule found"
    grep -q 'REJECT'                    <<<"$rules" && ok "explicit REJECT rule present (fast-fail on non-allowed egress)"  || warn "no explicit REJECT rule (relying on policy DROP)"
  else
    bad "cannot read iptables (no NET_ADMIN, or iptables missing): $rules"
  fi

  hdr "OUTPUT chain counters (-L OUTPUT -n -v)"
  priv iptables -L OUTPUT -n -v --line-numbers 2>/dev/null | sed 's/^/    /' \
    || warn "could not list OUTPUT counters"
else
  priv_skip "iptables ruleset dump" "iptables -S"
fi

# ---- 2. ipset allowed-domains (needs root to read) -------------------------
hdr "ipset allowed-domains"
if [ "$PRIV_OK" = 1 ]; then
  if ips=$(priv ipset list allowed-domains 2>&1); then
    n=$(grep -cE '^[0-9]' <<<"$ips")
    echo "    first entries:"; grep -E '^[0-9]' <<<"$ips" | head -n 8 | sed 's/^/      /'
    [ "$n" -gt 0 ] && ok "ipset has $n entries" || bad "ipset 'allowed-domains' is empty"
  else
    bad "ipset 'allowed-domains' not present: $ips"
  fi
else
  priv_skip "ipset dump" "ipset list allowed-domains"
fi

# ---- 3. DNS -----------------------------------------------------------------
hdr "DNS resolution (port 53 must be allowed)"
if getent hosts api.github.com >/dev/null 2>&1; then
  ok "resolved api.github.com"
elif command -v dig >/dev/null && dig +short api.github.com 2>/dev/null | grep -qE '[0-9]'; then
  ok "resolved api.github.com (via dig)"
else
  bad "DNS resolution is failing (allowlist by-name relies on this)"
fi

# ---- 4. allowed egress (expect CONNECT to succeed) -------------------------
hdr "Allowed egress — expect SUCCESS"
connects "https://api.github.com/zen"  && ok "api.github.com connects"    || bad  "api.github.com BLOCKED (allowlist too tight / GitHub ranges missing)"
connects "https://api.anthropic.com/"  && ok "api.anthropic.com connects" || bad  "api.anthropic.com BLOCKED (Claude Code egress would fail)"
connects "https://registry.npmjs.org/" && ok "registry.npmjs.org connects"|| warn "registry.npmjs.org blocked (it is in the allowlist — check its DNS)"

# ---- 5. blocked egress (expect FAILURE) ------------------------------------
hdr "Blocked egress — expect REJECT/timeout"
# raw IP first: needs no DNS, so it isolates pure egress filtering
if connects "https://1.1.1.1/"; then bad "1.1.1.1 REACHABLE — egress is NOT being filtered!"; else ok "1.1.1.1 blocked (as expected)"; fi
if connects "https://example.com/"; then bad "example.com REACHABLE — firewall is NOT effective!"; else ok "example.com blocked (as expected)"; fi

# ---- 6. ICMP (NoShareEnv intentionally allows ping) ------------------------
hdr "ICMP / ping (NoShareEnv allows ICMP)"
if command -v ping >/dev/null; then
  if ping -c1 -W3 8.8.8.8 >/dev/null 2>&1; then ok "ping 8.8.8.8 works (ICMP rule active)"
  elif [ "$PRIV_OK" = 1 ] && priv ping -c1 -W3 8.8.8.8 >/dev/null 2>&1; then ok "ping 8.8.8.8 works via sudo (ICMP rule active)"
  else warn "ping 8.8.8.8 failed (ICMP rule missing, the network drops ICMP, or ping lacks cap_net_raw for this user)"; fi
else
  warn "ping not installed in container"
fi

# ---- summary ----------------------------------------------------------------
hdr "Summary"
echo "  ${G}${pass} passed${N}, ${R}${fail} failed${N}"
if [ "$fail" -eq 0 ]; then
  echo "${G}${B}Firewall verification OK — in-container egress allowlist is in effect.${N}"; exit 0
else
  echo "${R}${B}Firewall verification found problems (see FAIL lines above).${N}"; exit 1
fi
