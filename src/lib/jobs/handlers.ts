import { TRIAGE_JOB_KIND, triageTicketJob } from "@/lib/support-ai";
import type { JobHandlers } from "./worker";

/**
 * Register job handlers here: one entry per job `kind`. `instrumentation.ts` hands this map to `startWorker`.
 * The helpdesk registers `triage-ticket` (issue 11.3).
 *
 *   export const handlers: JobHandlers = { "fetch-link": fetchLinkHandler };
 */
export const handlers: JobHandlers = { [TRIAGE_JOB_KIND]: triageTicketJob };
