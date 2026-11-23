-- #594: the email signature becomes a setting (app_state email_signature_html / _text,
-- Settings → Signature). Seeds the signature this install sent before the change, HTML and
-- text exactly as they were rendered, so existing installs send the same emails. Only when
-- the install already holds data (a campaign row): a fresh database gets no signature.
INSERT OR IGNORE INTO app_state (key, value)
SELECT 'email_signature_html', '<div class="missive_signature"><div>--</div><div><strong>Jane Doe</strong></div><div><span style="font-size: 13px">Founder</span></div><div><br></div><div><a href="https://ourco.example"><strong><span style="color: #005CD4">Ourco</span></strong></a><strong><span style="color: rgb(33, 33, 33)">&nbsp;</span></strong><span style="color: rgb(33, 33, 33)">—<span style="font-size: 13px">&nbsp;</span></span><em><span style="color: rgb(33, 33, 33)"><span style="font-size: 13px">Built For Where You''re Growing</span></span></em></div><div><a href="https://social.example.net/ourco"><span style="color: #005CD4"><span style="font-size: 13px">@ourco</span></span></a><strong><span style="color: #005CD4"><span style="font-size: 13px">&nbsp;</span></span></strong><span style="font-size: 13px">|</span><span style="color: #005CD4"><span style="font-size: 13px">&nbsp;</span></span><a href="mailto:support@ourco.example"><span style="color: #005CD4"><span style="font-size: 13px">Get Support</span></span></a><span style="color: #005CD4"><span style="font-size: 13px">&nbsp;| </span></span><a href="https://ourco.example/book/"><span style="color: #005CD4"><span style="font-size: 13px">Book a Call</span></span></a></div></div>'
WHERE EXISTS (SELECT 1 FROM campaigns);

INSERT OR IGNORE INTO app_state (key, value)
SELECT 'email_signature_text', '--
Jane Doe
Founder

Ourco — Built For Where You''re Growing
@ourco: https://social.example.net/ourco
Get Support: support@ourco.example
Book a Call: https://ourco.example/book/'
WHERE EXISTS (SELECT 1 FROM campaigns);
