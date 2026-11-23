// #262: the seeded Editorial builder template — a dark header bar, a teal hero
// (logo chip, eyebrow, display headline, intro, milestones, CTA + text link) and a
// white body (the campaign's content area, then an example steps list). Seeded by
// migrations/0072_editorial_template.sql; #269 swapped in the real logos and the
// guideline warm ink via 0073_editorial_template_logo.sql; #270 (0074_template_canvas.sql)
// made the hero's first row 2 columns. tests/editorial-template.test.ts keeps 0074's JSON
// identical to editorialTemplateBlocks().
// #595: no runtime code used it, so it moved from src/lib to this test fixture; the brand
// constants it read (BRAND, GUIDE, BRAND_LOGOS) are gone from $lib/brand, so their values
// are inlined here as the migrations stored them.
import type { Block, Inline } from '../../src/lib/blocks';

const BRAND = { teal: '#1a9ec4', body: '#333333', white: '#ffffff', onTeal: '#000000' } as const;
const GUIDE = { warmInk: '#15130e' } as const;
const BRAND_LOGOS = [
	{ key: 'primary-white', src: 'https://crm.myapp.example/img/logo-white.png' },
	{ key: 'primary', src: 'https://crm.myapp.example/img/logo.png' },
	{ key: 'logomark', src: 'https://crm.myapp.example/img/logomark.png' }
];

export const EDITORIAL_TEMPLATE_NAME = 'Ourco Editorial';

const logo = (key: string) => BRAND_LOGOS.find((l) => l.key === key)!.src;
/** The "Book a Call" link (also in the seeded signature setting, migration 0121). */
const BOOK_URL = 'https://ourco.example/book/';

const t = (text: string): Inline[] => [{ type: 'text', text }];

export function editorialTemplateBlocks(): Block[] {
	return [
		{
			id: 'ed-header',
			type: 'section',
			bg: GUIDE.warmInk,
			color: BRAND.white,
			padding: 'sm',
			width: 'full',
			align: 'center',
			blocks: [{ id: 'ed-logo', type: 'image', src: logo('primary-white'), alt: 'Ourco', href: 'https://ourco.example', width: 180 }]
		},
		{
			id: 'ed-hero',
			type: 'section',
			bg: BRAND.teal,
			color: BRAND.onTeal,
			padding: 'lg',
			width: 'full',
			blocks: [
				// #270: a hero row, 2 columns kept side by side on phones: logo chip on the
				// left, a decorative image on the right (swap in your own artwork).
				{
					id: 'ed-hero-row',
					type: 'columns',
					valign: 'middle',
					stack: false,
					cells: [
						[{ id: 'ed-chip', type: 'image', src: logo('logomark'), alt: 'Ourco', width: 48, style: 'chip' }],
						[{ id: 'ed-hero-art', type: 'image', src: logo('logomark'), alt: '', width: 96, align: 'right' }]
					]
				},
				{ id: 'ed-eyebrow', type: 'eyebrow', content: t('Campaign label') },
				{ id: 'ed-headline', type: 'heading', level: 1, size: 'display', text: 'Your big, bold headline goes here.', content: t('Your big, bold headline goes here.') },
				{
					id: 'ed-intro',
					type: 'paragraph',
					content: t('Intro paragraph: one or two sentences on why this email matters and what the reader should do next.')
				},
				{
					id: 'ed-milestones',
					type: 'milestones',
					rule: true,
					items: [1, 2, 3, 4].map((n) => ({ title: t(`Step ${n}`), label: t('Label') }))
				},
				{
					id: 'ed-cta',
					type: 'button',
					label: 'Book a call',
					href: BOOK_URL,
					align: 'left',
					linkLabel: BOOK_URL.replace(/^https:\/\//, ''),
					linkHref: BOOK_URL
				}
			]
		},
		{
			id: 'ed-body',
			type: 'section',
			bg: BRAND.white,
			color: BRAND.body,
			padding: 'lg',
			width: 'full',
			blocks: [
				{ id: 'ed-content', type: 'content' },
				{
					id: 'ed-steps',
					type: 'list',
					ordered: true,
					style: 'steps',
					items: [
						t('First step: what happens first, in a sentence.'),
						t('Second step: what the reader can expect next.'),
						t('Third step: the outcome. Delete this list if you do not need it.')
					]
				}
			]
		}
	];
}
