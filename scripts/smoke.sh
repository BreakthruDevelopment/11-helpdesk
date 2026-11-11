#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Customer side (always): two customers sign up; A opens a ticket; the portal lists it and the thread renders the
# message as text; B gets 404 on the page and the API and 403 on triage; writes are refused without our Origin.
# Public KB (always): search finds a seeded article, /kb and /kb/[slug] render published articles as plain text, and
# customers can't write articles. Agent side (only when SMOKE_AGENT_EMAIL and SMOKE_AGENT_PASSWORD are set; CI seeds
# an agent with `pnpm db:seed`, the live smoke covers the customer side only): internal note plus public reply, A sees
# the reply and not the note on the ticket page and in the inbox, first response stamped, pending_customer pauses the
# clock and A's reply resumes it, due times and the SLA state are set, the agent queue is ordered, and the agent
# writes knowledge-base articles (a draft stays out of public search and its /kb page is 404 until published).
# AI (demo mode in CI): the new ticket was triaged at creation (never urgent; recorded demo triage is not applied), the agent can re-triage and
# ask for a suggested reply, the draft is not sent (message count unchanged) and neither the draft nor the triage
# reaches the customer. Always: customers can't trigger or read triage or suggested replies (403), nor can
# anonymous callers (401).
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
home=$(curl -fsS "$BASE_URL/") || fail "home did not render"
echo "$home" | grep -q 'href="/support"' || fail "home should link to the support portal"
echo "$home" | grep -q 'href="/kb"' || fail "home should link to the knowledge base"
pass "pages render inside the shared shell"

for path in /dashboard /admin /support /support/new /inbox; do
  code=$(status "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard, admin, portal and inbox redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two customers signed up"

code=$(status -b "$JAR_A" "$BASE_URL/dashboard")
[ "$code" = "307" ] || fail "a customer's dashboard should redirect to the portal (307), got $code"
dash_headers=$(curl -s -o /dev/null -D - -b "$JAR_A" "$BASE_URL/dashboard")
echo "$dash_headers" | tr -d '\r' | grep -qi '^location: .*/support$' || fail "customer dashboard should redirect to /support: $dash_headers"
pass "a customer landing on the dashboard is sent to the portal"

empty=$(curl -fsS -b "$JAR_A" "$BASE_URL/support") || fail "support page did not render"
echo "$empty" | grep -q 'Explore breakthruventures.ai' || fail "support page is missing the shared footer"
echo "$empty" | grep -q 'You have no tickets yet' || fail "empty support list missing its empty state"
echo "$empty" | grep -q 'Open a ticket' || fail "support page missing the open action"
new_page=$(curl -fsS -b "$JAR_A" "$BASE_URL/support/new") || fail "new ticket page did not render"
echo "$new_page" | grep -q 'Describe the problem' || fail "new ticket form missing its label"
echo "$new_page" | grep -q 'name="subject"' || fail "new ticket form missing the subject field"
inbox_empty=$(curl -fsS -b "$JAR_A" "$BASE_URL/inbox") || fail "inbox page did not render"
echo "$inbox_empty" | grep -q 'No notifications yet' || fail "empty inbox missing its empty state"
pass "portal and inbox render for a customer"

# Sign-up can't choose a role: a customer is refused the agent endpoints.
code=$(status -b "$JAR_A" "$BASE_URL/api/admin/stats")
[ "$code" = "403" ] || fail "a customer reading admin stats should be 403, got $code"
pass "customers have no admin access"

code=$(status "$BASE_URL/api/tickets")
[ "$code" = "401" ] || fail "anonymous list should be 401, got $code"
pass "anonymous access refused"

new_ticket='{"subject":"smoke: cannot log in","body":"The page says invalid password.\nplain-text-canary <b>not-html</b>"}'
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

portal=$(curl -fsS -b "$JAR_A" "$BASE_URL/support") || fail "support list did not render"
echo "$portal" | grep -q 'cannot log in' || fail "support list missing the ticket"
echo "$portal" | grep -F -q 'Inbox, 1 unread' || fail "header missing the unread badge"
thread=$(curl -fsS -b "$JAR_A" "$BASE_URL/support/$TID") || fail "ticket page did not render"
echo "$thread" | grep -q 'invalid password' || fail "ticket page missing the message"
echo "$thread" | grep -q 'Send reply' || fail "ticket page missing the reply form"
echo "$thread" | grep -q 'Mark resolved' || fail "ticket page missing resolve"
echo "$thread" | grep -F -q 'plain-text-canary &lt;b&gt;not-html&lt;/b&gt;' || fail "ticket message was not rendered as plain text"
echo "$thread" | grep -F -q '<b>not-html</b>' && fail "ticket message was rendered as HTML"
echo "$thread" | grep -Eq 'assignee|triage|firstResponseDueAt' && fail "ticket page shows staff fields"
inbox_page=$(curl -fsS -b "$JAR_A" "$BASE_URL/inbox") || fail "inbox page did not render"
echo "$inbox_page" | grep -q 'We received your ticket' || fail "inbox page missing the notification"
echo "$inbox_page" | grep -q 'Mark read' || fail "inbox page missing mark read"
echo "$inbox_page" | grep -F -q '<b>not-html</b>' && fail "inbox rendered the message as HTML"
pass "portal lists the ticket, the thread is plain text, and the inbox shows it"

code=$(status -b "$JAR_B" "$BASE_URL/api/tickets/$TID")
[ "$code" = "404" ] || fail "customer B reading A's ticket should be 404, got $code"
code=$(status -b "$JAR_B" "$BASE_URL/support/$TID")
[ "$code" = "404" ] || fail "customer B opening A's ticket page should be 404, got $code"
code=$(status -X POST -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"body":"hi"}' "$BASE_URL/api/tickets/$TID/messages")
[ "$code" = "404" ] || fail "customer B replying on A's ticket should be 404, got $code"
code=$(status -X PATCH -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"action":"resolve"}' "$BASE_URL/api/tickets/$TID")
[ "$code" = "404" ] || fail "customer B resolving A's ticket should be 404, got $code"
code=$(status -X POST -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/tickets/$TID/triage")
[ "$code" = "403" ] || fail "customer B on the triage route should be 403, got $code"
code=$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/tickets/$TID/triage")
[ "$code" = "403" ] || fail "even the owner on the triage route should be 403, got $code"
for route in triage suggest-reply; do
  for jar in "$JAR_A" "$JAR_B"; do
    code=$(status -X POST -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/tickets/$TID/$route")
    [ "$code" = "403" ] || fail "a customer on the $route route should be 403, got $code"
    code=$(status -b "$jar" "$BASE_URL/api/tickets/$TID/$route")
    [ "$code" = "403" ] || fail "a customer reading $route should be 403, got $code"
  done
  code=$(status -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/tickets/$TID/$route")
  [ "$code" = "401" ] || fail "an anonymous call to the $route route should be 401, got $code"
done
b_list=$(curl -fsS -b "$JAR_B" "$BASE_URL/api/tickets")
echo "$b_list" | grep -q "$TID" && fail "B's ticket list contains A's ticket"
pass "customer B blocked from A's ticket (404); customers can't trigger or read triage or suggested replies (403), anonymous gets 401"

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

# Knowledge base, public pages: signed-out visitors see the list and an article as plain text; unknown slugs are 404.
kb_list=$(curl -fsS "$BASE_URL/kb") || fail "/kb did not render for a signed-out visitor"
echo "$kb_list" | grep -q 'Explore breakthruventures.ai' || fail "/kb is missing the shared footer"
echo "$kb_list" | grep -q 'aria-label="Search help articles"' || fail "/kb is missing its search form"
echo "$kb_list" | grep -q 'href="/kb/' || fail "/kb should list published articles"
kb_found=$(curl -fsS "$BASE_URL/kb?q=charged+twice+duplicate") || fail "/kb search did not render"
echo "$kb_found" | grep -q 'href="/kb/billing-duplicate-charges"' || fail "/kb search should find the duplicate-charges article"
[ "$(status "$BASE_URL/kb?q=%00")" = "200" ] || fail "/kb?q=%00 should be 200, not an error"
[ "$(status "$BASE_URL/kb?q=%22&offset=abc")" = "200" ] || fail "odd /kb query should still render"
kb_page=$(curl -fsS "$BASE_URL/kb/billing-duplicate-charges") || fail "/kb/[slug] did not render a published article"
echo "$kb_page" | grep -q '<strong>A pending authorization.</strong>' || fail "article Markdown (bold, lists) was not rendered"
echo "$kb_page" | grep -F -q '**' && fail "article page shows raw Markdown markers"
echo "$kb_page" | grep -q 'Open a ticket' || fail "article page missing the open-a-ticket link"
[ "$(status "$BASE_URL/kb/no-such-article-$RUN_ID")" = "404" ] || fail "an unknown article slug should be 404"
[ "$(status "$BASE_URL/kb/Not_A_Slug")" = "404" ] || fail "a malformed article slug should be 404"
pass "public /kb lists and searches published articles and /kb/[slug] shows one (unknown is 404)"

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
  thread=$(curl -fsS -b "$JAR_A" "$BASE_URL/support/$TID")
  echo "$thread" | grep -q 'looking into your login problem' || fail "portal should show the public reply"
  echo "$thread" | grep -q "$NOTE" && fail "portal shows the internal note"
  inbox_page=$(curl -fsS -b "$JAR_A" "$BASE_URL/inbox")
  echo "$inbox_page" | grep -q 'looking into your login problem' || fail "inbox page should show the reply"
  echo "$inbox_page" | grep -q "$NOTE" && fail "inbox page contains the internal note"
  code=$(status -b "$JAR_G" "$BASE_URL/support")
  [ "$code" = "307" ] || fail "an agent opening the customer portal should be redirected, got $code"
  pass "customer A sees the reply, never the note, on the ticket page and in the inbox"

  # AI (demo mode in CI): triage ran when the ticket was created, and the agent can re-run it and ask for a draft.
  # The draft is advice for the agent: nothing is sent, and neither it nor the triage is visible to the customer.
  agent_view=$(curl -fsS -b "$JAR_G" "$BASE_URL/api/tickets/$TID")
  # Live model: applied and marked set by AI. Demo mode: the recorded card is stored but category and priority are not applied.
  [ "$(echo "$agent_view" | jget 'j.ticket.triageSource')" = "ai" ] || [ "$(echo "$agent_view" | jget 'j.ticket.triage.demo')" = "true" ] || fail "the new ticket should have been triaged at creation: $agent_view"
  [ -n "$(echo "$agent_view" | jget 'j.ticket.triage.summary')" ] || fail "the triage has no summary: $agent_view"
  [ "$(echo "$agent_view" | jget 'j.ticket.priority')" != "urgent" ] || fail "triage must never set urgent: $agent_view"
  msgs_before=$(echo "$agent_view" | jget 'j.messages.length')
  triaged=$(curl -fsS -X POST -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/tickets/$TID/triage") || fail "agent re-triage failed"
  [ "$(echo "$triaged" | jget 'j.triage.retriagesLeft')" = "2" ] || fail "re-triage should leave 2 re-triages: $triaged"
  [ "$(curl -fsS -b "$JAR_G" "$BASE_URL/api/tickets/$TID/suggest-reply" | jget 'j.suggestion')" = "" ] || fail "no draft should exist before one is requested"
  suggested=$(curl -fsS -X POST -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/tickets/$TID/suggest-reply") || fail "agent suggest-reply failed"
  draft_text=$(echo "$suggested" | jget 'j.suggestion.reply')
  [ -n "$draft_text" ] || fail "suggest-reply returned no draft: $suggested"
  [ "$(echo "$suggested" | jget 'j.suggestion.aiGenerated')" = "true" ] || fail "the draft must be marked as AI-generated: $suggested"
  echo "$suggested" | grep -q "$NOTE" && fail "the draft contains the internal note"
  [ "$(curl -fsS -b "$JAR_G" "$BASE_URL/api/tickets/$TID/suggest-reply" | jget 'j.suggestion.reply')" = "$draft_text" ] || fail "the latest draft should be readable by the agent"
  [ "$(curl -fsS -b "$JAR_G" "$BASE_URL/api/tickets/$TID" | jget 'j.messages.length')" = "$msgs_before" ] || fail "a suggested reply must not be sent"
  a_view=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/tickets/$TID")
  echo "$a_view" | grep -qF "$draft_text" && fail "customer A can see the AI draft"
  echo "$a_view" | grep -Eqi 'triage|sentiment|needsHuman|suggestion' && fail "customer A's ticket carries AI fields: $a_view"
  curl -fsS -b "$JAR_A" "$BASE_URL/api/tickets" | grep -Eqi 'triage|sentiment|suggestion' && fail "customer A's list carries AI fields"
  pass "triage at creation (set by AI, not urgent); re-triage and suggested reply work; the draft is not sent and customers never see it"

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
  KB_SLUG=$(echo "$draft" | jget 'j.article.slug')
  [ "$(status "$BASE_URL/kb/$KB_SLUG")" = "404" ] || fail "a draft's /kb page should be 404 for the public"
  [ "$(status -b "$JAR_G" "$BASE_URL/kb/$KB_SLUG")" = "404" ] || fail "a draft's /kb page should be 404 even for an agent"
  curl -fsS "$BASE_URL/kb?q=$KB_WORD" | grep -q "/kb/$KB_SLUG" && fail "a draft is listed on /kb"
  curl -fsS -X PATCH -b "$JAR_G" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"status":"published"}' "$BASE_URL/api/kb/articles/$KB_ID" >/dev/null || fail "agent could not publish"
  [ "$(curl -fsS "$BASE_URL/api/kb?q=$KB_WORD" | jget 'j.articles[0].title')" = "$KB_WORD draft article" ] || fail "the published article should be in public search"
  kb_art=$(curl -fsS "$BASE_URL/kb/$KB_SLUG") || fail "the published article's /kb page should render"
  echo "$kb_art" | grep -q "Steps about $KB_WORD" || fail "the published article page is missing its body"
  curl -fsS "$BASE_URL/kb?q=$KB_WORD" | grep -q "href=\"/kb/$KB_SLUG\"" || fail "the published article should be listed on /kb"
  code=$(status -X DELETE -b "$JAR_G" -H "origin: $BASE_URL" "$BASE_URL/api/kb/articles/$KB_ID")
  [ "$code" = "204" ] || fail "agent delete should be 204, got $code"
  [ "$(curl -fsS "$BASE_URL/api/kb?q=$KB_WORD" | jget 'j.articles.length')" = "0" ] || fail "a deleted article is still searchable"
  [ "$(status "$BASE_URL/kb/$KB_SLUG")" = "404" ] || fail "a deleted article's /kb page should be 404"
  pass "agent drafted, published and deleted an article; the draft never showed in public search"
else
  echo "skip - agent checks (set SMOKE_AGENT_EMAIL and SMOKE_AGENT_PASSWORD)"
fi

code=$(status -X PATCH -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"action":"resolve"}' "$BASE_URL/api/tickets/$TID")
[ "$code" = "200" ] || fail "owner resolve should be 200, got $code"
resolved_page=$(curl -fsS -b "$JAR_A" "$BASE_URL/support/$TID") || fail "resolved ticket page did not render"
echo "$resolved_page" | grep -q 'Resolved' || fail "resolved ticket page should show Resolved"
echo "$resolved_page" | grep -q 'Mark resolved' && fail "a resolved ticket should not offer Mark resolved"
echo "$resolved_page" | grep -q 'Send reply' || fail "a recently resolved ticket should still accept a reply"
pass "customer A marked their ticket resolved"

echo "SMOKE PASS"
