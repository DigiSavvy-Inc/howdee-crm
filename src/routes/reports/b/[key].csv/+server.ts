import type { RequestHandler } from './$types';
import { builtInCsvResponse } from '$lib/server/reports/page';

// #456: a built-in's CSV, with the page's `p_` params (and an optional `?limit=`).
export const GET: RequestHandler = (event) => builtInCsvResponse(event);
