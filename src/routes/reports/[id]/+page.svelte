<script lang="ts">
	import ReportBuilder from '$lib/components/ReportBuilder.svelte';

	let { data, form } = $props();
</script>

<ReportBuilder {data} {form} />
