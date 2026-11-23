<script lang="ts">
	// #509: the builder's Style tab — preset first, then colours, shape and type, with a live
	// preview beside (≥ 900px) or below.
	import ColorField from '$lib/components/ColorField.svelte';
	import FormRenderer from '$lib/components/FormRenderer.svelte';
	import {
		FONT_KEYS,
		FONT_LABELS,
		RADII,
		STYLE_PRESETS,
		WIDTHS,
		applyPreset,
		type FormSpec,
		type FormStyle
	} from '$lib/forms';

	let {
		spec = $bindable(),
		readonly = false,
		logoSrc,
		appName
	}: { spec: FormSpec; readonly?: boolean; logoSrc: string; appName: string } = $props();

	function set<K extends keyof FormStyle>(k: K, v: FormStyle[K]) {
		spec.style = { ...spec.style, [k]: v, ...(k !== 'radius' && k !== 'width' && k !== 'font' && k !== 'logo' ? { preset: 'custom' } : {}) };
	}
	const colors: { key: 'bg' | 'surface' | 'text' | 'muted' | 'border' | 'accent'; label: string; against: 'bg' | 'surface' | null }[] = [
		{ key: 'bg', label: 'Page background', against: null },
		{ key: 'surface', label: 'Fields & cards', against: null },
		{ key: 'text', label: 'Text', against: 'bg' },
		{ key: 'muted', label: 'Help text', against: 'bg' },
		{ key: 'border', label: 'Borders', against: null },
		{ key: 'accent', label: 'Accent (button)', against: 'bg' }
	];
</script>

<div class="style-tab">
	<fieldset class="controls" disabled={readonly}>
		<div class="group">
			<h3>Preset</h3>
			<div class="presets" role="radiogroup" aria-label="Preset">
				{#each STYLE_PRESETS as p (p.key)}
					<button
						type="button"
						role="radio"
						aria-checked={spec.style.preset === p.key}
						class="preset"
						class:on={spec.style.preset === p.key}
						onclick={() => (spec.style = applyPreset(spec.style, p.key))}
					>
						<span class="sw" style="background:{p.colors.bg};box-shadow:inset 0 0 0 1px {p.colors.border}">
							<span class="sw-dot" style="background:{p.colors.accent}"></span>
						</span>
						{p.label}
					</button>
				{/each}
			</div>
			<p class="muted small">A preset sets the colours; width, corners, font and logo stay as they are.</p>
		</div>

		<div class="group">
			<h3>Colours</h3>
			{#each colors as c (c.key)}
				<ColorField
					label={c.label}
					value={spec.style[c.key]}
					auto={false}
					against={c.against ? spec.style[c.against] : null}
					onchange={(hex) => hex && set(c.key, hex)}
				/>
			{/each}
			<ColorField
				label="Text on the button"
				value={spec.style.accent_text || null}
				against={spec.style.accent}
				againstLabel="the accent"
				onchange={(hex) => set('accent_text', hex ?? '')}
			/>
		</div>

		<div class="group">
			<h3>Layout</h3>
			<label>Width
				<select value={spec.style.width} onchange={(e) => set('width', Number(e.currentTarget.value))}>
					{#each WIDTHS as w (w)}<option value={w}>{w}px</option>{/each}
				</select>
			</label>
			<label>Corners
				<select value={spec.style.radius} onchange={(e) => set('radius', Number(e.currentTarget.value))}>
					{#each RADII as r (r)}<option value={r}>{r === 0 ? 'Square' : `${r}px`}</option>{/each}
				</select>
			</label>
			<label>Font
				<select value={spec.style.font} onchange={(e) => set('font', e.currentTarget.value as FormStyle['font'])}>
					{#each FONT_KEYS as f (f)}<option value={f}>{FONT_LABELS[f]}</option>{/each}
				</select>
			</label>
			<label class="tick"><input type="checkbox" checked={spec.style.cards} onchange={(e) => set('cards', e.currentTarget.checked)} /> Questions on cards</label>
			<label class="tick"><input type="checkbox" checked={spec.style.logo} onchange={(e) => set('logo', e.currentTarget.checked)} /> Show the logo (Settings → Branding)</label>
		</div>
	</fieldset>

	<div class="preview" aria-label="Preview">
		<FormRenderer {spec} style={spec.style} preview embedded {logoSrc} {appName} />
	</div>
</div>

<style>
	.style-tab { display: grid; gap: var(--space-l); grid-template-columns: 1fr; }
	@media (min-width: 900px) {
		.style-tab { grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); align-items: start; }
		.preview { position: sticky; top: calc(var(--header-bar-h, 0px) + var(--space-m)); }
	}
	.controls { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-l); min-width: 0; }
	.group { display: flex; flex-direction: column; gap: var(--space-s); }
	h3 { margin: 0; font-size: var(--size-s); line-height: var(--line-s); font-weight: var(--weight-ui-medium); }
	label { display: flex; flex-direction: column; gap: var(--space-xxs); font-size: var(--size-s); line-height: var(--line-s); }
	label.tick { flex-direction: row; align-items: center; gap: var(--space-xs); }
	.presets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-xs); }
	.preset { display: flex; align-items: center; gap: var(--space-xs); background: var(--surface); color: var(--text); box-shadow: var(--border-shadow-s); border: 0; border-radius: var(--radius); padding: var(--space-xs); font-size: var(--size-s); cursor: pointer; text-align: left; }
	.preset.on { box-shadow: inset 0 0 0 var(--border-l) var(--btn-primary-bg); }
	.sw { width: 28px; height: 20px; border-radius: 4px; display: inline-flex; align-items: flex-end; justify-content: flex-end; padding: 3px; flex: none; }
	.sw-dot { width: 10px; height: 6px; border-radius: 2px; }
	.small { font-size: var(--size-xs); line-height: var(--line-xs); margin: 0; }
	.preview { border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--border-shadow-s); min-width: 0; }
</style>
