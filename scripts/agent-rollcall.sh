#!/usr/bin/env bash
# Agent Roll Call — smoke test all agents and infrastructure services.
# Reports container status, A2A agent card, and endpoint health.
#
# Usage: ./scripts/agent-rollcall.sh
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
header() { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}"; }

FAILURES=0

# ─── Agent definitions ────────────────────────────────────────────
# Format: container:host_port:check_type:display_name
# check_type: a2a (has /.well-known/agent.json), http (just check response), health (/health)
# A2A external agents are read LIVE from workstacean's /api/agents registry (in
# the "A2A — external services" section below) instead of a static list, so a
# remote agent shows up the moment the SkillBroker registers it (e.g. protopen
# once steamdeck is online + reinstated in workspace/agents.yaml). Tailnet-only
# remotes also get a direct card-health check in the "Remote" section.

# Remote agents — not Docker containers, accessed over Tailscale
# Format: host:port:display_name
REMOTE_AGENTS=(
  "steamdeck:7870:protoPen (Security/Research — Steam Deck)"
)

INFRA=(
  "workstacean:8081:http:Workstacean (Orchestrator — hosts the in-process DeepAgents)"
  "protomaker-server:3008:http:protoMaker Server"
  "protomaker-ui:3009:http:protoMaker UI"
  "gateway:4000:http:LiteLLM Gateway"
  "gateway-db::container:Gateway Postgres"
  "graphiti::container:Graphiti (Knowledge Graph)"
  "open-webui:3000:http:Open WebUI"
  "vllm:8000:http:vLLM Inference"
  "langfuse-web:3001:http:Langfuse"
  "caddy::container:Caddy (TLS Proxy)"
  "cloudflared::container:Cloudflared (Tunnel)"
  "searxng::container:SearXNG"
)

MEDIA=(
  "sonarr:8989:http:Sonarr"
  "radarr:7878:http:Radarr"
  "prowlarr:9696:http:Prowlarr"
  "lidarr:8686:http:Lidarr"
  "jellyfin:8096:http:Jellyfin"
  "bazarr:6767:http:Bazarr"
  "seerr:5055:http:Seerr"
  "rclone::container:rclone (Sync)"
  "romm:8098:http:Romm"
  "lazylibrarian::container:LazyLibrarian"
  "mylar3::container:Mylar3"
  "audiobookshelf::container:Audiobookshelf"
  "kavita::container:Kavita"
)

MONITORING=(
  "prometheus:9090:http:Prometheus"
  "grafana:3000:http:Grafana"
  "node-exporter::container:Node Exporter"
  "cadvisor:8280:http:cAdvisor"
  "seedbox-quota-exporter::container:Seedbox Quota Exporter"
)

check_service() {
  local container host_port check_type display_name
  IFS=: read -r container host_port check_type display_name <<< "$1"

  # Check container status
  local status
  status=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo "missing")

  if [[ "$status" != "running" ]]; then
    fail "${display_name}: container ${status}"
    return
  fi

  # Container-only check (no port exposed)
  if [[ "$check_type" == "container" ]]; then
    local uptime
    uptime=$(docker inspect -f '{{.State.StartedAt}}' "$container" 2>/dev/null | cut -dT -f1)
    pass "${display_name}: running (since ${uptime})"
    return
  fi

  # HTTP check
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:${host_port}/" 2>/dev/null || echo "000")

  if [[ "$check_type" == "a2a" ]]; then
    local card_code
    card_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:${host_port}/.well-known/agent.json" 2>/dev/null || echo "000")
    if [[ "$card_code" == "200" ]]; then
      local agent_name agent_version skills
      agent_name=$(curl -s --max-time 3 "http://localhost:${host_port}/.well-known/agent.json" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('name','?'))" 2>/dev/null || echo "?")
      agent_version=$(curl -s --max-time 3 "http://localhost:${host_port}/.well-known/agent.json" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('version','?'))" 2>/dev/null || echo "?")
      skills=$(curl -s --max-time 3 "http://localhost:${host_port}/.well-known/agent.json" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); s=d.get('skills',d.get('capabilities',[])); print(', '.join([x.get('id',x.get('name','?')) for x in s]) if s else 'none')" 2>/dev/null || echo "?")
      pass "${display_name}: v${agent_version} — A2A card OK, skills: [${skills}]"
    else
      warn "${display_name}: running (HTTP ${http_code}) but no A2A card (${card_code})"
    fi
  elif [[ "$check_type" == "health" ]]; then
    local health_code
    health_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:${host_port}/health" 2>/dev/null || echo "000")
    if [[ "$health_code" == "200" ]]; then
      pass "${display_name}: healthy"
    else
      warn "${display_name}: running but /health returned ${health_code}"
    fi
  else
    if [[ "$http_code" =~ ^(200|301|302|401|403|404)$ ]]; then
      pass "${display_name}: responding (HTTP ${http_code})"
    elif [[ "$http_code" == "000" ]]; then
      fail "${display_name}: container running but port ${host_port} not responding"
    else
      warn "${display_name}: HTTP ${http_code}"
    fi
  fi
}

check_remote_agent() {
  local host port display_name
  IFS=: read -r host port display_name <<< "$1"

  local card card_code
  # `|| card_code=$?` keeps an unreachable remote agent from tripping
  # `set -e` and aborting the whole roll call (e.g. steamdeck offline → curl 28).
  card_code=0
  card=$(curl -s --max-time 5 "http://${host}:${port}/.well-known/agent.json" 2>/dev/null) || card_code=$?

  if [[ $card_code -ne 0 ]] || [[ -z "$card" ]]; then
    fail "${display_name}: unreachable (${host}:${port})"
    return
  fi

  local agent_name agent_version skills
  agent_name=$(echo "$card" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('name','?'))" 2>/dev/null || echo "?")
  agent_version=$(echo "$card" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('version','?'))" 2>/dev/null || echo "?")
  skills=$(echo "$card" | python3 -c "import json,sys; d=json.load(sys.stdin); s=d.get('skills',d.get('capabilities',[])); print(', '.join([x.get('id',x.get('name','?')) for x in s]) if isinstance(s,list) and s else 'none')" 2>/dev/null || echo "?")
  pass "${display_name}: v${agent_version} — A2A card OK, skills: [${skills}]"
}

echo -e "${BOLD}🔍 Agent Roll Call — $(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo -e "${DIM}$(docker ps --format '{{.Names}}' | wc -l) containers running${NC}"

header "Agents (In-process DeepAgents)"
# These live inside workstacean, registered from workspace/agents/*.yaml.
# Parse from the latest log line showing registration.
# Real line: "[agent-runtime] Registered 4 agent(s) [deep-agent: 3, proto-sdk: 1]:
# quinn(deep-agent), ava(deep-agent), proto(proto-sdk), protobot(deep-agent)".
DEEP_AGENT_LINE=$(docker logs workstacean 2>&1 | grep -E "Registered [0-9]+ agent\(s\)" | tail -1 || true)
if [[ -n "$DEEP_AGENT_LINE" ]]; then
  # Summary bracket "[deep-agent: 3, proto-sdk: 1]" + the "name(runtime)" list
  # after the final "]: ".
  SUMMARY=$(echo "$DEEP_AGENT_LINE" | sed -n 's/.*Registered \([0-9]\+ agent(s) \[[^]]*\]\).*/\1/p')
  [[ -n "$SUMMARY" ]] && echo -e "  ${DIM}${SUMMARY}${NC}"
  AGENT_LIST=$(echo "$DEEP_AGENT_LINE" | sed -n 's/.*\]: \(.*\)$/\1/p')
  IFS=',' read -ra _agents <<< "$AGENT_LIST"
  for a in "${_agents[@]}"; do
    a=$(echo "$a" | xargs)
    [[ -n "$a" ]] && pass "${a} — in-process, running in workstacean"
  done
else
  warn "Could not parse agent registration from workstacean logs"
fi

header "Agents (A2A — external services)"
# Live A2A executor registry from workstacean (the SkillBroker registers these
# from workspace/agents.yaml + card discovery). This is the dispatchable view —
# a card being reachable (see "Remote") doesn't mean workstacean has registered
# it as an executor.
A2A_JSON=$(docker exec workstacean sh -c 'curl -s -H "X-API-Key: $WORKSTACEAN_API_KEY" http://localhost:3000/api/agents' 2>/dev/null || true)
A2A_REGISTERED=$(echo "$A2A_JSON" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin).get("data", []) or []
except Exception:
    data = []
for a in data:
    name = a.get("name", "?")
    skills = a.get("skills") or a.get("skillNames") or []
    n = len(skills) if isinstance(skills, list) else 0
    print(f"{name}\t{n}")
' 2>/dev/null)
if [[ -z "$A2A_REGISTERED" ]]; then
  echo -e "  ${DIM}none registered in workstacean${NC}"
else
  while IFS=$'\t' read -r _a2a_name _a2a_nskills; do
    [[ -z "$_a2a_name" ]] && continue
    if [[ "$_a2a_nskills" =~ ^[0-9]+$ && "$_a2a_nskills" -gt 0 ]]; then
      pass "${_a2a_name} — registered A2A executor in workstacean (${_a2a_nskills} skill(s))"
    else
      pass "${_a2a_name} — registered A2A executor in workstacean"
    fi
  done <<< "$A2A_REGISTERED"
fi

header "Agents (Remote)"
for svc in "${REMOTE_AGENTS[@]}"; do check_remote_agent "$svc"; done

header "AI Infrastructure"
for svc in "${INFRA[@]}"; do check_service "$svc"; done

header "Media Stack"
for svc in "${MEDIA[@]}"; do check_service "$svc"; done

header "Monitoring"
for svc in "${MONITORING[@]}"; do check_service "$svc"; done

echo ""
if [[ $FAILURES -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}All systems operational.${NC}"
else
  echo -e "${RED}${BOLD}${FAILURES} service(s) down.${NC}"
fi
echo ""
