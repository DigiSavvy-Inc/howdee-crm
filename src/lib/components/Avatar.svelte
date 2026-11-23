<script lang="ts">
	// #105: a contact's resolved avatar (Gravatar/GitHub/domain favicon/initials), served by
	// the session-gated /api/avatar/[id] route. `name` is accepted for API stability / a
	// future title use; alt stays "" on purpose — it's decorative next to visible name text.
	let { contactId, name, size = 32 }: { contactId: number; name: string; size?: number } = $props();
</script>

<img
	class="avatar"
	src="/api/avatar/{contactId}"
	alt=""
	title={name || undefined}
	width={size}
	height={size}
	loading="lazy"
	decoding="async"
	style="width: {size}px; height: {size}px;"
/>

<style>
	.avatar {
		border-radius: var(--radius-full);
		object-fit: cover;
		background: var(--neutral-3);
		display: inline-block;
		vertical-align: middle;
		flex-shrink: 0;
	}
</style>
