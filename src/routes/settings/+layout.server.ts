import type { LayoutServerLoad } from './$types';
import { snapshot } from '$lib/server/snapshot';

// #604: the Snapshots tab only shows while SNAPSHOT_MODE turns the feature on.
export const load: LayoutServerLoad = async (event) => ({
	snapshotsEnabled: snapshot.enabled(event.platform?.env)
});
