import { headers } from "next/headers";
import { cache } from "react";
import { allowPublicRequest, clientIpFromHeaders } from "@/lib/ip-limit";

/**
 * The public KB pages' per-IP limit (the same bucket as GET /api/kb). Memoised per request, so a page and its
 * `generateMetadata` together count as one request.
 */
export const kbAllowed = cache(async (): Promise<boolean> => allowPublicRequest(clientIpFromHeaders(await headers())));
