<script lang="ts">
	// #374: the unsubscribe page's optional video. An embed's src is built from the parsed
	// provider + id (embedSrc), never the pasted URL; an upload plays from /img/unsubscribe/….
	// Never autoplays. Responsive 16:9, full width of its column.
	import { embedSrc, mediaUrl, PROVIDER_LABELS, type PageVideo } from '$lib/unsubscribe-page';

	let { video, caption = '' }: { video: PageVideo; caption?: string } = $props();

	const title = $derived(caption || (video.kind === 'embed' ? `${PROVIDER_LABELS[video.provider]} video` : 'Video'));
	const src = $derived(video.kind === 'embed' ? embedSrc(video) : mediaUrl(video.key));
	const poster = $derived(video.kind === 'upload' ? mediaUrl(video.posterKey) : null);
</script>

{#if src}
	<figure class="unsub-video">
		<div class="ratio">
			{#if video.kind === 'embed'}
				<iframe
					{src}
					{title}
					loading="lazy"
					allow="fullscreen; picture-in-picture; encrypted-media"
					allowfullscreen
					referrerpolicy="strict-origin-when-cross-origin"
				></iframe>
			{:else}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video controls preload="metadata" playsinline {title} aria-label={title} poster={poster ?? undefined}>
					<source {src} type={video.type} />
				</video>
			{/if}
		</div>
		{#if caption}<figcaption>{caption}</figcaption>{/if}
	</figure>
{/if}

<style>
	figure { margin: 0; width: 100%; }
	.ratio {
		position: relative;
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: var(--radius-m);
		overflow: hidden;
		background: var(--neutral-2);
	}
	iframe, video {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: 0;
		background: #000;
	}
	figcaption {
		margin-top: var(--space-xs);
		font-size: var(--size-s);
		line-height: var(--line-s);
		letter-spacing: var(--letter-spacing-s);
		color: var(--neutral-7);
	}
</style>
