// #594: the signature this install sent before it became a setting — HTML and text exactly as
// the old hardcoded $lib/signature rendered them. Migration 0121 seeds the same values;
// tests/email-signature-594.test.ts checks they match byte for byte.
import type { EmailSignature } from '../../src/lib/signature';

export const LEGACY_SIGNATURE: EmailSignature = {
	html: '<div class="missive_signature"><div>--</div><div><strong>Jane Doe</strong></div><div><span style="font-size: 13px">Founder</span></div><div><br></div><div><a href="https://ourco.example"><strong><span style="color: #005CD4">Ourco</span></strong></a><strong><span style="color: rgb(33, 33, 33)">&nbsp;</span></strong><span style="color: rgb(33, 33, 33)">—<span style="font-size: 13px">&nbsp;</span></span><em><span style="color: rgb(33, 33, 33)"><span style="font-size: 13px">Built For Where You\'re Growing</span></span></em></div><div><a href="https://social.example.net/ourco"><span style="color: #005CD4"><span style="font-size: 13px">@ourco</span></span></a><strong><span style="color: #005CD4"><span style="font-size: 13px">&nbsp;</span></span></strong><span style="font-size: 13px">|</span><span style="color: #005CD4"><span style="font-size: 13px">&nbsp;</span></span><a href="mailto:support@ourco.example"><span style="color: #005CD4"><span style="font-size: 13px">Get Support</span></span></a><span style="color: #005CD4"><span style="font-size: 13px">&nbsp;| </span></span><a href="https://ourco.example/book/"><span style="color: #005CD4"><span style="font-size: 13px">Book a Call</span></span></a></div></div>',
	text: '--\nJane Doe\nFounder\n\nOurco — Built For Where You\'re Growing\n@ourco: https://social.example.net/ourco\nGet Support: support@ourco.example\nBook a Call: https://ourco.example/book/'
};
