#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Customer side (always): two customers sign up; A opens a ticket; B gets 404 on it and 403 on triage; writes are
# refused without our Origin. Agent side (only when SMOKE_AGENT_EMAIL and SMOKE_AGENT_PASSWORD are set; CI seeds an
# agent with `pnpm db:seed`, the live smoke covers the customer side only): internal note plus public reply, A sees
# the reply and not the note, the inbox message has no note text, first response stamped, pending_customer pauses
# the clock and A's reply resumes it, due times and the SLA state are set, the agent queue is ordered, and the agent
# writes knowledge-base articles (a draft stays out of public search until published). Always: public KB search
# finds a seeded article, and customers can't write articles. The AI triage checks arrive with 11.3.
#   BASE_URL=https://app11.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"; JAR_G="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$JAR_G"' EXIT
NOTE="internal-note-canary-$RUN_ID"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
# jget '<expression on j>' reads JSON on stdin, e.g. jget 'j.ticket.id'
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=eval(process.argv[1]);process.stdout.write(v===undefined||v===null?"":String(v))})' "$1"; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(status "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two customers signed up"

# Sign-up can't choose a role: a customer is refused the agent endpoints.
code=$(status -b "$JAR_A" "$BASE_URL/api/admin/stats")
[ "$code" = "403" ] || fail "a customer reading admin stats should be 403, got $code"
pass "customers have no admin access"

code=$(status "$BASE_URL/api/tickets")
[ "$code" = "401" ] || fail "anonymous list should be 401, got $code"
pass "anonymous access refused"

new_ticket='{"subject":"smoke: cannot log in","body":"The page says invalid password."}'
code=$(status -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' -d "$new_ticket" "$BASE_URL/api/tickets")
[ "$code" = "403" ] || fail "cross-origin create should be 403, got $code"
code=$(status -b "$JAR_A" -H 'content-type: application/json' -d "$new_ticket" "$BASE_URL/api/tickets")
[ "$code" = "403" ] || fail "create without an Origin should be 403, got $code"
code=$(status -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{nope' "$BASE_URL/api/tickets")
[ "$code" = "400" ] || fail "malformed JSON should be 400, got $code"
code=$(head -c 40000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  --data-binary @- "$BASE_URL/api/tickets")
[ "$code" = "413" ] || fail "oversized body should be 413, got $code"
code=$(status -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"subject":"x","body":"y","priority":"urgent"}' "$BASE_URL/api/tickets")
[ "$code" = "400" ] || fail "a customer-chosen priority should be 400, got $code"
pass "cross-origin, malformed, oversized and queue-jumping writes refused"

created=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$new_ticket" "$BASE_URL/api/tickets") || fail "create ticket failed"
TID=$(echo "$created" | jget 'j.ticket.id')
[ -n "$TID" ] || fail "no ticket id in $created"
[ "$(echo "$created" | jget 'j.ticket.status')" = "new" ] || fail "new ticket should be status new: $created"
echo "$created" | grep -Eq 'assignee|triage|dueAt|version' && fail "a customer's ticket response must not carry staff fields: $created"
pass "customer A opened a ticket"

code=$(status -b "$JAR_B" "$BASE_URL/api/tickets/$TID")
[ "$code" = "404" ] || fail "customer B reading A's ticket should be 404, got $code"
code=$(status -X POST -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"body":"hi"}' "$BASE_URL/api/tickets/$TID/messages")
[ "$code" = "404" ] || fail "customer B replying on A's ticket should be 404, got $code"
code=$(status -X PATCH -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"action":"resolve"}' "$BASE_URL/api/tickets/$TID")
[ "$code" = "404" ] || fail "customer B resolving A's ticket should be 404, got $code"
code=$(status -X POST -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/tickets/$TID/triage")
[ "$code" = "403" ] || fail "customer B on the triage route should be 403, got $code"
code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/tickets/$TID/triage")
[ "$code" = "403" ] || fail "even the owner on the triage route should be 403, got $code"
b_list=$(curl -fsS -b "$JAR_B" "$BASE_URL/api/tickets")
echo "$b_list" | grep -q "$TID" && fail "B's ticket list contains A's ticket"
pass "customer B blocked from A's ticket (404) and from triage (403)"

code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"body\":\"$NOTE\",\"visibility\":\"internal\"}" "$BASE_URL/api/tickets/$TID/messages")
[ "$code" = "403" ] || fail "a customer writing an internal note should be 403, got $code"
pass "customers can't write internal notes"

# Knowledge base, public side: needs no sign-in, finds a seeded article, never errors on odd input; customers can't write.
kb=$(curl -fsS "$BASE_URL/api/kb?q=charged+twice+duplicate") || fail "public KB search failed"
[ "$(echo "$kb" | jget 'j.articles[0].slug')" = "billing-duplicate-charges" ] || fail "KB search should find the duplicate-charges article first: $kb"
echo "$kb" | grep -q '"authorId"\|"status"\|"body"' && fail "public KB results carry non-public fields: $kb"
[ "$(status "$BASE_URL/api/kb?q=%22")" = "200" ] || fail "odd KB query should still be 200"
[ "$(status "$BASE_URL/api/kb?limit=1000")" = "400" ] || fail "KB limit over the cap should be 400"
code=$(status "$BASE_URL/api/kb/articles")
[ "$code" = "401" ] || fail "anonymous KB article list should be 401, got $code"
code=$(status -b "$JAR_A" "$BASE_URL/api/kb/articles")
[ "$code" = "403" ] || fail "a customer listing KB articles (drafts) should be 403, got $code"
code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"title":"x","body":"y"}' "$BASE_URL/api/kb/articles")
[ "$code" = "403" ] || fail "a customer writing a KB article should be 403, got $code"
pass "public KB search works; customers can't read drafts or write articles"

if [ -n "${SMOKE_AGENT_EMAIL:-}" ] && [ -n "${SMOKE_AGENT_PASSWORD:-}" ]; then
  curl -fsS -c "$JAR_G" -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$SMOKE_AGENT_EMAIL\",\"password\":\"$SMOKE_AGENT_PASSWORD\"}" \
    "$BASE_URL/api/auth/sign-in/email" >/dev/null || fail "agent sign-in failed"

  agent_view=$(curl -fsS -b "$JAR_G" "$BASE_URL/api/tickets/$TID") || fail "agent could not read the ticket"
  [ -n "$(echo "$agent_view" | jget 'j.ticket.firstResponseDueAt')" ] || fail "first response due time not set: $agent_view"
  [ -n "$(echo "$agent_view" | jget 'j.ticket.resolutionDueAt')" ] || fail "resolution due time not set: $agent_view"
  [ "$(echo "$agent_view" | jget 'j.ticket.sla.state')" = "ok" ] || fail "a fresh ticket's SLA state should be ok: $agent_view"
  queue=$(curl -fsS -b "$JAR_G" "$BASE_URL/api/tickets?view=unassigned&limit=100") || fail "agent could not load the queue"
  echo "$queue" | grep -q "$TID" || fail "the new ticket is missing from the unassigned queue"
  ordered='(()=>{const d=j.tickets.map(t=>t.sla.nextDueAt);const n=d.findIndex(x=>x===null);const live=n<0?d:d.slice(0,n);return live.every((x,i)=>i===0||live[i-1]<=x)&&(n<0||d.slice(n).every(x=>x===null))})()'
  [ "$(echo "$queue" | jget "$ordered")" = "true" ] || fail "the queue is not ordered by due time (running clocks first, soonest first)"
  pass "agent sees the ticket with SLA due times and state set, in a queue ordered by due time"

  code=$(status -X POST -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"body\":\"$NOTE\",\"visibility\":\"internal\"}" "$BASE_URL/api/tickets/$TID/messages")
  [ "$code" = "201" ] || fail "agent internal note should be 201, got $code"
  code=$(status -X POST -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"body":"Thanks, we are looking into your login problem."}' "$BASE_URL/api/tickets/$TID/messages")
  [ "$code" = "201" ] || fail "agent public reply should be 201, got $code"
  pass "agent added an internal note and a public reply"

  a_view=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/tickets/$TID")
  echo "$a_view" | grep -q 'looking into your login problem' || fail "customer A should see the public reply"
  echo "$a_view" | grep -q "$NOTE" && fail "customer A can see the internal note"
  a_inbox=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/inbox")
  echo "$a_inbox" | grep -q 'looking into your login problem' || fail "customer A's inbox should hold the reply notification"
  echo "$a_inbox" | grep -q "$NOTE" && fail "customer A's inbox contains the internal note"
  a_list=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/tickets")
  echo "$a_list" | grep -q "$NOTE" && fail "customer A's list contains the internal note"
  pass "customer A sees the reply, never the note; the inbox message has no note text"

  agent_view=$(curl -fsS -b "$JAR_G" "$BASE_URL/api/tickets/$TID")
  [ -n "$(echo "$agent_view" | jget 'j.ticket.firstRespondedAt')" ] || fail "first response was not stamped: $agent_view"
  [ "$(echo "$agent_view" | jget 'j.ticket.status')" = "open" ] || fail "a replied-to new ticket should be open: $agent_view"
  pass "first response stamped"

  version=$(echo "$agent_view" | jget 'j.ticket.version')
  paused=$(curl -fsS -X PATCH -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"version\":$version,\"status\":\"pending_customer\"}" "$BASE_URL/api/tickets/$TID") || fail "agent could not set pending_customer"
  [ -n "$(echo "$paused" | jget 'j.ticket.pausedAt')" ] || fail "pending_customer should pause the clock: $paused"
  code=$(status -X PATCH -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"version\":$version,\"priority\":\"high\"}" "$BASE_URL/api/tickets/$TID")
  [ "$code" = "409" ] || fail "a stale version should be 409, got $code"
  code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"body":"Here are the details you asked for."}' "$BASE_URL/api/tickets/$TID/messages")
  [ "$code" = "201" ] || fail "customer reply should be 201, got $code"
  resumed=$(curl -fsS -b "$JAR_G" "$BASE_URL/api/tickets/$TID")
  [ -z "$(echo "$resumed" | jget 'j.ticket.pausedAt')" ] || fail "the customer's reply should resume the clock: $resumed"
  [ "$(echo "$resumed" | jget 'j.ticket.status')" = "open" ] || fail "the customer's reply should reopen the work: $resumed"
  pass "pending_customer paused the clock, a stale version was refused, the customer's reply resumed it"

  # Knowledge base, agent side: a draft is invisible to the public until published.
  KB_WORD="smokekb${RUN_ID}"
  draft=$(curl -fsS -X POST -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"title\":\"$KB_WORD draft article\",\"body\":\"Steps about $KB_WORD.\"}" "$BASE_URL/api/kb/articles") || fail "agent could not create a draft article"
  KB_ID=$(echo "$draft" | jget 'j.article.id')
  [ "$(echo "$draft" | jget 'j.article.status')" = "draft" ] || fail "a new article should be a draft: $draft"
  [ "$(curl -fsS "$BASE_URL/api/kb?q=$KB_WORD" | jget 'j.articles.length')" = "0" ] || fail "a draft appeared in public search"
  [ "$(curl -fsS -b "$JAR_G" "$BASE_URL/api/kb?q=$KB_WORD" | jget 'j.articles.length')" = "0" ] || fail "a draft appeared in public search for an agent"
  [ "$(curl -fsS -b "$JAR_G" "$BASE_URL/api/kb/articles?status=draft&q=$KB_WORD" | jget 'j.articles.length')" = "1" ] || fail "agent list should show the draft"
  curl -fsS -X PATCH -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"status":"published"}' "$BASE_URL/api/kb/articles/$KB_ID" >/dev/null || fail "agent could not publish"
  [ "$(curl -fsS "$BASE_URL/api/kb?q=$KB_WORD" | jget 'j.articles[0].title')" = "$KB_WORD draft article" ] || fail "the published article should be in public search"
  code=$(status -X DELETE -b "$JAR_G" -H "origin: $BASE_URL" "$BASE_URL/api/kb/articles/$KB_ID")
  [ "$code" = "204" ] || fail "agent delete should be 204, got $code"
  [ "$(curl -fsS "$BASE_URL/api/kb?q=$KB_WORD" | jget 'j.articles.length')" = "0" ] || fail "a deleted article is still searchable"
  pass "agent drafted, published and deleted an article; the draft never showed in public search"
else
  echo "skip - agent checks (set SMOKE_AGENT_EMAIL and SMOKE_AGENT_PASSWORD)"
fi

code=$(status -X PATCH -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"action":"resolve"}' "$BASE_URL/api/tickets/$TID")
[ "$code" = "200" ] || fail "owner resolve should be 200, got $code"
pass "customer A marked their ticket resolved"

echo "SMOKE PASS"
