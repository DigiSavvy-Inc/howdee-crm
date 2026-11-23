import type { RequestHandler } from './$types';
import { reportCsvResponse } from '$lib/server/reports/page';

export const GET: RequestHandler = (event) => reportCsvResponse(event);
