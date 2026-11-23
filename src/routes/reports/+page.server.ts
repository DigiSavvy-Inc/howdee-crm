import type { PageServerLoad } from './$types';
import { loadHome } from '$lib/server/reports/page';

export const load = ((event) => loadHome(event)) satisfies PageServerLoad;
