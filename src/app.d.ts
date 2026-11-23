// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	/** #609: newest file in migrations/, defined at build time (vite.config.ts). */
	const __LATEST_MIGRATION__: string;

	interface Env {
		/** Worker secret. Name only — never log the value. */
	}

	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties
		}

		// interface Error {}
		interface Locals {
			authed: boolean;
			user: import('$lib/server/users').SessionUser | null;
			/** #491: set when the request is for the newsletter archive's public host. */
			archivePublic?: { base: string } | null;
		}
		interface PageData {
			/** #270: opt a page into the wide content column (visual editor + Design panel). */
			wideLayout?: boolean;
		}
		// interface PageState {}
	}
}

export {};
