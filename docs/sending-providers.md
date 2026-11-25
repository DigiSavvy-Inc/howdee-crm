# Sending providers

Every email the app sends (broadcasts, automation emails, scheduled sends, 1:1 emails, replies,
confirmations, invites and password resets) goes out through one **sending provider**. The provider
is the service that hands the mail to the recipient's server. An install uses one provider at a time.

Postmark is the default. An install that keeps Postmark works exactly as before and needs no change.
The other choices are Resend, Amazon SES and any SMTP server you have an account on.

The provider only moves mail. The contacts, the lists, the suppression list, the unsubscribe page,
the reports and the history all stay in the CRM, whichever provider you pick.

## What each provider does

| | Postmark | Resend | Amazon SES | Custom SMTP |
| --- | --- | --- | --- | --- |
| **Sending** | Up to 500 messages per API call | Up to 100 messages per API call | One API call per message, paced to your SES maximum send rate | One message at a time over one reused connection, paced by a sends-per-minute setting |
| **Broadcast and transactional mail** | Two message streams | One account; each message is tagged with its stream | Two configuration sets | One server for both |
| **Opens and clicks** | Postmark, or the CRM | Resend (set per domain), or the CRM | SES (set per configuration set), or the CRM | Always the CRM |
| **Bounces** | Webhook | Webhook | SNS notification | Refusals at send time, plus bounce messages (DSNs) read at the reply-capture address |
| **Spam complaints** | Webhook | Webhook | SNS notification | Not available |
| **Provider suppression list** | Synced both ways, per stream | Synced both ways when your account has Resend's Suppressions API, otherwise read from webhooks | Synced both ways with the account-level suppression list | None: the CRM's list only |
| **Domain status in the app** | DKIM and Return-Path (with `POSTMARK_ACCOUNT_TOKEN`) | Domain and DNS record status (needs a full-access key) | Verification, DKIM and custom MAIL FROM status | Not available: check DNS yourself |
| **Reply capture** | Postmark Inbound | Postmark Inbound | Postmark Inbound | Postmark Inbound |

<!-- confirm: Resend's Suppressions API was in private beta when this was written ("APIs might change before GA"). Check that list, add and remove are generally available before building two-way sync. -->

Reply capture is separate from sending. It uses Postmark Inbound with every provider, so you can
send through SES and still capture replies with a free Postmark inbound address. See
[self-hosting.md, step 9](self-hosting.md#9-optional-reply-capture).

## Choosing a provider in Settings → Sending

**Settings → Sending** (admins) is where you pick the provider and check it works.

1. **Choose the provider.** Postmark, Resend, Amazon SES or Custom SMTP. A provider whose adapter
   isn't in this version yet is listed as "coming soon" and can't be chosen (Postmark is the only one
   so far; Resend, SES and SMTP follow). The page lists what the active provider supports, using the
   rows of the table above, for example "Opens tracked by the CRM" or "Complaints: not available".
2. **Enter the credentials.** Each provider's fields are listed in its section below. Secrets are
   stored encrypted with `MAIL_TOKEN_KEY`, like the other integration secrets, and every change is
   written to the audit log with who made it and when, never the value (the page lists the latest
   changes under **Changes**). After saving, a secret only ever shows as set or not set (with who set
   it and when). Without `MAIL_TOKEN_KEY` the secret fields are disabled and the app
   reads the Worker secrets instead (see [Environment variables](#environment-variables)). A field
   that is empty in Settings but set as a Worker secret says "Using the Worker secret".
3. **Test connection.** This checks the credentials without sending anything:
   - Postmark reads the server and both message streams.
   - Resend lists your domains. A sending-only key passes, with a note that domain status and
     suppression sync are off.
   - SES reads the account (sandbox or production, daily quota, send rate), the From domain's identity
     and both configuration sets.
   - SMTP connects, upgrades to TLS, signs in and says goodbye. It reports the server's greeting, the
     sign-in method it used and the largest message size the server accepts.
4. **Send a test to me.** Sends one real email to your own address through the chosen provider, on
   the transactional stream, from the default From address. The page shows the provider's message
   id. When the webhook is set up, the test's delivery event moves the page's "Last event received"
   time within a minute (reload the page), which proves events are arriving too.
5. **Make active.** The provider becomes the one every new send uses. You can't switch while a
   campaign is sending. Read [Switching providers](#switching-providers-on-a-live-install) first if
   this install has already sent mail.

The page also shows the webhook URL to register for the chosen provider and the time the last event
arrived from it.

Settings → Setup asks the active provider for its checks: credentials, streams or configuration
sets, and how its events reach the app. For Postmark these are the server token, both message
streams, a webhook on the broadcast stream pointing at this install, and Custom unsubscribe
handling. A token saved in Settings → Sending counts as set; one that can't be read is a problem
(see [Environment variables](#environment-variables)).

The default From address is set in Settings → General, as before, and falls back to the
`POSTMARK_FROM` var for every provider. It must be on a domain verified with the active provider.

## Postmark

Nothing changes. Follow [self-hosting.md, step 8](self-hosting.md#8-connect-postmark): the Server
API token, the broadcast and transactional message streams, the webhook and Custom unsubscribe
handling.

| Setting | Worker secret or var | Notes |
| --- | --- | --- |
| Server API token | `POSTMARK_TOKEN` | Not the account token. Settings → Sending or the Worker secret. |
| Broadcast stream | `POSTMARK_STREAM` | Usually `broadcast`. Settings → Sending or the var. |
| Transactional stream | `POSTMARK_STREAM_TX` | Usually `outbound`. Settings → Sending or the var. |
| Account token (optional) | `POSTMARK_ACCOUNT_TOKEN` | DKIM and Return-Path status. Worker secret only. |
| Webhook key | `WEBHOOK_KEY` | Goes in the webhook URL. Worker secret only. |

Settings → Sending shows whether the account token and the webhook key are set, never their values.

The Postmark webhook keeps its current URL:

```
https://crm.example.com/api/webhook?key=<WEBHOOK_KEY>
```

## Resend

**What you need:** a Resend account with your sending domain verified (Resend → Domains).

**Credentials**

| Setting | Worker secret | Notes |
| --- | --- | --- |
| API key | `RESEND_API_KEY` | Resend → API Keys. **Full access** lets the app show domain status and sync suppressions. **Sending access** (optionally limited to one domain) only sends. |
| Webhook signing secret | `RESEND_WEBHOOK_SECRET` | Shown on the webhook's details page in Resend. Starts with `whsec_`. |

**Streams.** Resend has no message streams. Broadcast and transactional mail go out from the same
account, and the app tags each message with `stream` (`broadcast` or `transactional`) and the ids of
the campaign, contact and send. If you want broadcasts to have their own reputation, send them from
a subdomain (for example `news.example.com`) verified in Resend, and use an address on it as the
campaign's From.

**Webhook.** In Resend → Webhooks, choose **Add Webhook** and enter:

```
https://crm.example.com/api/webhook/resend
```

Select these events: `email.delivered`, `email.bounced`, `email.complained`, `email.opened`,
`email.clicked`, `email.suppressed` and `email.failed`. Add `suppression.added` and
`suppression.removed` too if your account has them. Then copy the signing secret into Settings →
Sending.

The app checks every request's signature before it reads anything. Resend signs webhooks with Svix:
the `svix-id`, `svix-timestamp` and `svix-signature` headers, and an HMAC-SHA256 over
`<svix-id>.<svix-timestamp>.<raw body>` keyed with the base64-decoded part of the secret after
`whsec_`. A request with a bad signature, or a timestamp more than 5 minutes from now, gets a 401.

<!-- confirm: the Svix scheme above is from Svix's own docs; Resend's page names the three svix-* headers but doesn't spell out the signed string. Check a recorded Resend request against it. -->

**How Resend events map**

| Resend event | Recorded as |
| --- | --- |
| `email.delivered` | delivery |
| `email.opened` | open (only while Resend does the tracking) |
| `email.clicked` | click (only while Resend does the tracking) |
| `email.bounced` with `bounce.type` `Permanent` | hard bounce: the contact is suppressed |
| `email.bounced` with another type | soft bounce: recorded, not suppressed |
| `email.suppressed` | hard bounce: Resend refused to send to a suppressed address |
| `email.complained` | spam complaint: the contact is suppressed |
| `email.failed` | the send is marked failed, with Resend's reason |
| `suppression.added` / `suppression.removed` | suppression sync |

<!-- confirm: Resend's docs give `Permanent` and `Temporary` as example bounce.type values; check the full set against a recorded soft bounce. -->

**Tracking.** Open and click tracking in Resend are settings on each domain (Resend → Domains → your
domain → Configuration). Turn them on if Resend should track, or off if the CRM should (see
[Open and click tracking by the CRM](#open-and-click-tracking-by-the-crm)). Resend can't turn
tracking off for one message, so **Test connection** warns when the domain's setting and the app's
setting disagree.

<!-- confirm: Resend's domain API says click_tracking and open_tracking only take effect once a tracking subdomain is set up and verified. Check whether that is now required, and say so here if it is. -->

**Unsubscribe headers.** The app sends its own `List-Unsubscribe` and `List-Unsubscribe-Post` headers
in each message's `headers`.

<!-- confirm: Resend's docs show a custom List-Unsubscribe header but no List-Unsubscribe-Post example. Check both survive to the delivered message. -->

## Amazon SES

**What you need:**

- An AWS account with SES in one region, and your sending domain verified there as an identity with
  Easy DKIM. A custom MAIL FROM domain (for example `mail.example.com`) is recommended so the
  Return-Path aligns with your From domain.
- Production access. A new SES account starts in the sandbox, where it can only send to verified
  addresses. **Test connection** says which one you are in.

**Credentials**

| Setting | Worker secret or var | Notes |
| --- | --- | --- |
| Access key id | `AWS_SES_ACCESS_KEY_ID` (secret) | For an IAM user with the policy below |
| Secret access key | `AWS_SES_SECRET_ACCESS_KEY` (secret) | |
| Region | `AWS_SES_REGION` (var) | The region your identity is in, for example `us-east-1` |
| Broadcast configuration set | `AWS_SES_CONFIGURATION_SET` (var) | For example `crm-broadcast` |
| Transactional configuration set | `AWS_SES_CONFIGURATION_SET_TX` (var) | For example `crm-transactional` |
| SNS topic ARN | `AWS_SES_SNS_TOPIC_ARN` (var) | The topic both configuration sets publish to |

The app signs its own requests (Signature Version 4) and calls the SES v2 API in your region. There
is no AWS SDK.

**Minimum IAM permissions.** Create an IAM user just for the app and attach this policy. Replace the
region, account id, domain and configuration set names with yours.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Send",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": [
        "arn:aws:ses:us-east-1:111122223333:identity/example.com",
        "arn:aws:ses:us-east-1:111122223333:configuration-set/crm-broadcast",
        "arn:aws:ses:us-east-1:111122223333:configuration-set/crm-transactional"
      ]
    },
    {
      "Sid": "Checks",
      "Effect": "Allow",
      "Action": ["ses:GetAccount", "ses:GetEmailIdentity", "ses:GetConfigurationSet"],
      "Resource": "*"
    },
    {
      "Sid": "Suppressions",
      "Effect": "Allow",
      "Action": [
        "ses:ListSuppressedDestinations",
        "ses:GetSuppressedDestination",
        "ses:PutSuppressedDestination",
        "ses:DeleteSuppressedDestination"
      ],
      "Resource": "*"
    }
  ]
}
```

The app needs no SNS permissions: it confirms the subscription by visiting the link SNS sends.

<!-- confirm: AWS maps the v2 SendEmail operation to ses:SendEmail, ses:SendRawEmail and ses:SendTemplatedEmail without saying which one simple content needs. Test with ses:SendEmail alone and drop ses:SendRawEmail if it isn't needed. -->

**Configuration sets.** In SES → Configuration sets, create two: one for broadcasts and one for
transactional mail. They play the part of Postmark's two streams. Turn on the account-level
suppression list for both (it is on by default for accounts created after November 2019).

**Events through SNS.**

1. In SNS, create a topic of type **Standard** in the same region (SES does not publish to FIFO
   topics). One topic can serve both configuration sets.
2. Edit the topic's access policy so SES may publish to it:

   ```json
   {
     "Effect": "Allow",
     "Principal": { "Service": "ses.amazonaws.com" },
     "Action": "sns:Publish",
     "Resource": "arn:aws:sns:us-east-1:111122223333:crm-events",
     "Condition": {
       "StringEquals": { "AWS:SourceAccount": "111122223333" }
     }
   }
   ```

   AWS's own example also pins `AWS:SourceArn` to one configuration set. With two configuration sets
   on one topic, leave that condition out or list both ARNs.
3. Enter the topic's ARN in Settings → Sending and save. **Do this before step 4**, or the app
   ignores the confirmation request.
4. In SNS → Subscriptions, create a subscription on the topic with protocol **HTTPS** and endpoint:

   ```
   https://crm.example.com/api/webhook/ses
   ```

   Leave **raw message delivery** off. The app checks the confirmation request's signature and
   confirms the subscription itself. Its status in SNS changes to Confirmed within a minute.
5. On each configuration set, add an event destination of type **Amazon SNS** pointing at the topic,
   with these event types: Delivery, Hard bounces, Complaints and Rejects. Add Opens and Clicks only
   if SES should do the tracking.

The app checks every SNS message before it reads it: the signature against the certificate at
`SigningCertURL` (which must be an `https://sns.<region>.amazonaws.com/` address), with SHA1 for
`SignatureVersion` 1 and SHA256 for 2, and the `TopicArn`, which must equal the configured topic.
Anything else gets a 401. A retry with the same message id is recorded once.

<!-- confirm: the console names of the event types in step 5 ("Hard bounces", "Rejects") and whether choosing hard bounces also delivers the Transient bounces SES publishes after it stops retrying. -->

**How SES events map**

| SES `eventType` | Recorded as |
| --- | --- |
| `Delivery` | delivery |
| `Open` | open (only while SES does the tracking) |
| `Click` | click (only while SES does the tracking). A click SES marks `isBotEvent: Likely` is recorded as a scanner click. |
| `Bounce` with `bounceType` `Permanent` | hard bounce: the contact is suppressed |
| `Bounce` with `Transient` or `Undetermined` | soft bounce: recorded, not suppressed |
| `Complaint` | spam complaint: the contact is suppressed |
| `Reject` | the send is marked failed (SES found a virus) |
| `Send`, `DeliveryDelay`, `Rendering Failure`, `Subscription` | ignored |

**Tracking.** SES tracks opens and clicks only when the configuration set's event destination
includes Opens and Clicks. Leave those out when the CRM does the tracking.

**Suppressions.** The account-level suppression list only holds bounces and complaints, and it
applies to all mail from the account, transactional included. So the app copies bounced and
complained addresses to it and reads new entries back, but never puts an unsubscribed address on
it: someone who unsubscribed from your newsletter can still get a password reset.

**Domain status.** Settings → Domain and the Deliverability page show the identity's verification,
DKIM and MAIL FROM status from SES.

## Custom SMTP

Any SMTP server you can sign in to: a transactional mail service's SMTP relay, your own mail server,
or a hosted mailbox. A mailbox service (the SMTP side of a personal or office mailbox) is fine for
testing and small lists but usually has low daily limits and isn't meant for bulk mail.

**Credentials**

| Setting | Worker secret or var | Notes |
| --- | --- | --- |
| Host | `SMTP_HOST` (var) | For example `smtp.example.com` |
| Port | `SMTP_PORT` (var) | `587` (STARTTLS) or `465` (TLS) |
| Username | `SMTP_USER` (secret) | |
| Password | `SMTP_PASSWORD` (secret) | Often an app password or an API key, not your sign-in password |
| Sign-in method | `SMTP_AUTH` (var) | `auto` (default), `plain` or `login` |
| Sends per minute | `SMTP_MAX_PER_MINUTE` (var) | Default 60. Set it at or below your server's limit. |
| Bounce address | `SMTP_ENVELOPE_FROM` (var) | `auto` (default), `from` or `inbound`. See [Bounces with SMTP](#bounces-with-smtp). |

**Ports.** Cloudflare Workers can't open connections on port 25, so the app offers two:

- **587** starts in plain text and upgrades with STARTTLS before signing in.
- **465** uses TLS from the first byte.

The app never sends your username or password before the connection is encrypted. A server that
doesn't offer STARTTLS on 587 is refused. Workers also can't connect to Cloudflare's own IP ranges
or to private addresses, so the host must be a public server that isn't proxied by Cloudflare.

**How it sends.** The app builds each message itself: a multipart text and HTML body, UTF-8
headers, its own `Message-ID`, and `List-Unsubscribe` plus `List-Unsubscribe-Post` on broadcasts.
Each tick opens one connection, sends up to the sends-per-minute setting over it, and closes it.
A 5,000-contact broadcast at 60 a minute takes about an hour and a half.

**DKIM.** The app doesn't DKIM-sign. Your SMTP server must sign mail for your From domain, or the
large mailbox providers will treat broadcasts as unauthenticated. Check this with your SMTP provider
before the first broadcast.

**No webhook.** SMTP has no event webhook. Opens and clicks are always tracked by the CRM, and
bounces come from the two sources described below. Spam complaints aren't available.

## Open and click tracking by the CRM

The CRM can track opens and clicks itself instead of the provider. It always does for SMTP. For
Postmark, Resend and SES it is a choice: **Settings → Sending → Open and click tracking**,
**By the provider** (the default) or **By the CRM**. The env var is `MAIL_TRACKING`
(`provider` or `crm`).

How it works:

- **Opens.** Each tracked email gets a 1x1 transparent image from your own app,
  `https://crm.example.com/t/o/<token>`. Loading it records an open.
- **Clicks.** Each link in the HTML part is rewritten to `https://crm.example.com/t/c/<token>`,
  which records the click and redirects to the original address. The plain-text part keeps the
  original links, so a click from a text-only reader isn't counted.
- **Signed links.** The token carries the send, the recipient and, for clicks, the destination, and
  is signed with `SESSION_SECRET`. The redirect only goes to the destination inside a valid
  signature. A changed or unsigned link shows a "This link isn't valid" page and redirects nowhere,
  so the route can't be used as an open redirect.
- **What isn't rewritten.** The unsubscribe link and the List-Unsubscribe header, `mailto:` and
  `tel:` links, links to a place on the same page, relative links and links over 2,000 characters.
  Only broadcasts, scheduled sends, resends and automation emails are tracked. Personal 1:1 emails
  and transactional mail (replies, confirmations, invites, password resets) get no pixel and no
  rewritten links at all.
- **Same data as before.** Opens and clicks land in the same events as the provider's, so campaign
  stats, the contact timeline, engagement, scoring, segments, triggers and reports work the same.
  The scanner-click rules (bursts of clicks from mail security scanners) and the Apple Mail Privacy
  Protection rule for opens apply as they do to Postmark events. The app stores the user agent and
  Cloudflare's country for the request, not the IP address. Loading the same pixel or link twice
  within one second counts once.
- **The unsubscribe link and scanners.** The unsubscribe link isn't rewritten, so the app can't see
  a click on it. Instead, opening the unsubscribe page counts as that click when the page's link
  points to exactly one tracked email. Then the "unsubscribe link plus any other link in a few
  seconds" scanner rule works as it does with the provider. Opening the page never unsubscribes
  anyone. When one link could belong to more than one email (a resend, or a second pass through an
  automation, uses the same link), nothing is recorded, and only the "several different links in a
  few seconds" rule applies to that email.
- **Apple Mail Privacy Protection.** Apple's mail proxy loads the pixel by itself, which isn't a
  real open. The provider can usually tell these apart by the client it sees. The CRM only has
  the user agent and how soon after delivery the open came. So with the CRM, more of these
  automatic opens are counted as real opens than with the provider.
- **Limits.** At most 30 opens and 60 clicks are stored per email per hour. After that the image
  still loads and links still go where they should, but nothing more is stored and no tags or
  automations run for them. This stops a page that reloads in a loop from filling the database.
- **Your own domain.** Tracking links use the app's public address (Settings → Domain, else
  `PUBLIC_BASE_URL`). Moving to a custom domain later keeps old links working: every address the app
  answers on accepts them.

When the CRM tracks, the app asks the provider not to track (Postmark per message). Resend and SES
can't be told per message, so turn their tracking off as described in their sections. While the CRM
tracks, the app ignores open and click events from the provider for the mail it tracked, so
nothing is counted twice. Mail sent before the switch keeps counting the provider's events.

Switching from one to the other only affects mail sent afterwards. Links in mail already sent keep
working: the CRM's own links always, and the provider's for as long as that provider account exists.

Rotating `SESSION_SECRET` breaks the tracking links (and unsubscribe links) in mail already sent.

## Bounces with SMTP

With no webhook, the app learns about bounces in two ways.

**Refused at send time.** When the server answers a recipient or the message with a permanent
error (a `5xx` reply, such as `550 5.1.1 user unknown`), that recipient is recorded as a hard bounce
straight away and suppressed. A temporary error (`4xx`) leaves the message queued, and it is tried
again on a later tick, up to 3 times over about an hour. After that it is recorded as a soft bounce.
An error that isn't about one recipient (sign-in failed, the server refused the sender) stops the
tick's sending and shows on Settings → Sending and Settings → Setup. No contact is marked.

**Bounce messages (DSNs).** Many servers accept a message first and only find out later that it
can't be delivered. They then send a bounce message, a delivery status notification, to the
message's envelope sender (the Return-Path). The app reads these when they arrive at the
reply-capture address:

- A DSN whose status is `5.x.x` with action `failed` is a hard bounce and suppresses the contact.
  `4.x.x` failures are soft bounces. `delayed` notices are ignored.
- It is matched to the send by the tagged envelope address, else by the original `Message-ID` in the
  returned headers, else by the failed recipient and a recent send to them.
- A DSN is never stored as a reply or forwarded to your inbox.

For DSNs to reach the reply-capture address, the envelope sender must point there. That is the
**Bounce address** setting:

| `SMTP_ENVELOPE_FROM` | Envelope sender | DSNs |
| --- | --- | --- |
| `auto` (default) | `inbound` when reply capture is on a domain you own, otherwise `from` | |
| `inbound` | `<local>+b<send id>@<your inbound domain>` | Read by the app |
| `from` | Your From address | Go to your From mailbox; the app only sees refusals at send time |

Use `inbound` only with an inbound domain of your own, ideally a subdomain of your From domain (for
example `reply.example.com` for `news@example.com`), and add your SMTP server to that domain's SPF
record. The receiving server checks SPF against the envelope sender's domain, so Postmark's shared
inbound hash address won't do: with that, `auto` keeps the From address.

Some SMTP services replace the envelope sender with their own. With those, DSNs go to the service,
not to you, and the app only sees refusals at send time.

## Rules that hold for every provider

- **The CRM's suppression list is the source of truth.** Unsubscribed, bounced, complained and
  archived contacts are never sent to, whatever the provider supports. The check runs in the app
  before a message reaches the provider. Where the provider has its own list, it is kept in sync both
  ways: Settings → Deliverability's **Sync from \<provider\>** reads it, once a day and about 15
  minutes after each broadcast, as it does with Postmark today.
- **One-click unsubscribe on every broadcast.** Each broadcast carries the app's unsubscribe link,
  `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. A broadcast missing
  them is never sent. The unsubscribe page records the reason.
- **The assistant never sends.** It has no tool that sends, schedules, activates or enrolls, with
  any provider. It can't read or change Settings → Sending.
- **Credentials are never logged**, never shown after saving and never included in backups.
- **Every webhook checks its signature first** and records a retry only once.

## Switching providers on a live install

You can switch at any time, except while a campaign is sending. Here is what happens.

**Before you switch**

1. Verify your sending domain with the new provider. DKIM records for two providers can sit side by
   side. If your SPF record lists the old provider, add the new one too until the switch is done.
2. Set up the new provider's credentials and webhook, then use **Test connection** and **Send a test
   to me**.
3. Run **Sync from \<old provider\>** on Settings → Deliverability once more, so every bounce and
   complaint it knows about is in the CRM.

**When you switch**

- Every send from then on goes through the new provider: scheduled campaigns, automations, 1:1
  emails and system mail. Nothing has to be rescheduled.
- **History stays.** Each send records its provider next to the provider's message id. Sends made
  before this feature count as Postmark. Reports, the send log, contact timelines and Conversations
  don't change.
- **Suppressions stay.** They live in the CRM. The app copies the bounced and complained addresses
  to the new provider's list, where it has one, on its first sync.
- **Reply capture** is unaffected. It stays on Postmark Inbound.

**After you switch**

- Leave the old provider's webhook in place for about 30 days. Late bounces, complaints and opens
  for mail it sent still arrive and still count. The app keeps accepting events for sends a provider
  made, as long as that provider's webhook secret (or `WEBHOOK_KEY` for Postmark) stays set.
- The new provider's sending reputation starts fresh. For a large list, send to your most engaged
  contacts first and grow the volume over a couple of weeks.
- When you are done with the old provider, clear its credentials in Settings → Sending.

## Environment variables

Everything in Settings → Sending can also come from the Worker's environment. A value saved in
Settings wins. A secret is set with `npx wrangler secret put <NAME>`, a var goes in `vars` in
`wrangler.jsonc`.

A secret saved in Settings → Sending that can't be read (`MAIL_TOKEN_KEY` missing, invalid or
changed since it was saved) is never replaced by the Worker secret, which may belong to another
Postmark server. Sending stops instead: every send fails with "The sending token saved in Settings →
Sending can't be read. Check MAIL_TOKEN_KEY, or save the token again.", the Worker logs one line
without the value, and Settings → Sending and Settings → Setup show the token as a problem. Domain
authentication and the stream check on Deliverability use the same token and streams as sending, so
they say the same. Restore the old `MAIL_TOKEN_KEY`, save the token again, or choose **Clear token**
to go back to `POSTMARK_TOKEN`. Only when nothing is saved does the Worker secret apply.

| Name | Kind | Provider | What it is |
| --- | --- | --- | --- |
| `MAIL_PROVIDER` | var | all | `postmark` (default), `resend`, `ses` or `smtp`. The choice saved in Settings → Sending wins. A provider whose adapter isn't in this version yet is ignored (Postmark is used). |
| `MAIL_TRACKING` | var | Postmark, Resend, SES | `provider` (default) or `crm`. SMTP always uses `crm`. |
| `POSTMARK_FROM` | var | all | Fallback default From address, when Settings → General has none. Name unchanged. |
| `POSTMARK_TOKEN`, `POSTMARK_STREAM`, `POSTMARK_STREAM_TX`, `POSTMARK_ACCOUNT_TOKEN`, `WEBHOOK_KEY` | as today | Postmark | Unchanged. Only required while Postmark is the provider. |
| `RESEND_API_KEY` | secret | Resend | The API key |
| `RESEND_WEBHOOK_SECRET` | secret | Resend | The webhook signing secret, `whsec_…` |
| `AWS_SES_ACCESS_KEY_ID` | secret | SES | IAM access key id |
| `AWS_SES_SECRET_ACCESS_KEY` | secret | SES | IAM secret access key |
| `AWS_SES_REGION` | var | SES | For example `us-east-1` |
| `AWS_SES_CONFIGURATION_SET` | var | SES | Broadcast configuration set |
| `AWS_SES_CONFIGURATION_SET_TX` | var | SES | Transactional configuration set |
| `AWS_SES_SNS_TOPIC_ARN` | var | SES | The SNS topic events come from |
| `SMTP_HOST` | var | SMTP | Server host name |
| `SMTP_PORT` | var | SMTP | `587` or `465` |
| `SMTP_USER` | secret | SMTP | Username |
| `SMTP_PASSWORD` | secret | SMTP | Password |
| `SMTP_AUTH` | var | SMTP | `auto` (default), `plain` or `login` |
| `SMTP_MAX_PER_MINUTE` | var | SMTP | Default `60` |
| `SMTP_ENVELOPE_FROM` | var | SMTP | `auto` (default), `from` or `inbound` |

The full list with a comment per name is `.dev.vars.reference`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Test connection: Resend "restricted" or 401 on domains | The key has sending access only. Sending works; domain status and suppression sync need a full-access key. |
| Resend webhook requests get 401 | The signing secret in Settings is wrong or from another webhook, or the Worker's clock check failed because the request was replayed late. Copy the secret again from the webhook's page. |
| SNS subscription stays "Pending confirmation" | The topic ARN wasn't saved in Settings → Sending before the subscription was made, or it names another topic. Fix it, then choose **Request confirmation** on the subscription in SNS. |
| SES: "Email address is not verified" | The account is still in the sandbox, or the From domain is verified in a different region from `AWS_SES_REGION`. |
| SES events arrive but nothing is counted | The configuration set names in Settings don't match the ones the mail was sent with, or raw message delivery is on for the subscription. Turn it off. |
| SMTP: connection times out | Port 25 is blocked on Workers: use 587 or 465. Otherwise the host is behind Cloudflare's proxy or on a private address, which Workers can't reach. |
| SMTP: "server does not offer STARTTLS" | Port 587 on that server is plain text only. Use 465 if the server offers it. |
| SMTP: sign-in fails | Many services need an app password or an API key as the password. Try `SMTP_AUTH=login` if `auto` picks a method the server rejects. |
| SMTP: no bounces ever arrive | The envelope sender isn't the reply-capture address (see [Bounces with SMTP](#bounces-with-smtp)), or your SMTP service replaces it. Refusals at send time are still recorded. |
| Opens and clicks counted twice | The provider is tracking while **By the CRM** is chosen. Turn tracking off on the Resend domain or remove Opens and Clicks from the SES event destination. |
| Clicks show "This link isn't valid" | `SESSION_SECRET` was changed after the mail went out. Links signed with the old secret no longer verify. |
| No opens at all with CRM tracking | Many mail apps block images until the reader allows them. Clicks are the more reliable signal. |
| Can't switch provider | A campaign is sending. Wait for it to finish. |
| "The sending token saved in Settings → Sending can't be read" | `MAIL_TOKEN_KEY` is missing or not the key the token was saved with. Put the old key back, save the token again, or clear it to use `POSTMARK_TOKEN`. |

## Adding another provider

A provider is an adapter behind `MailProvider` in `src/lib/server/mail/provider.ts`, the same
pattern as the AI providers ([ai-providers.md](ai-providers.md)). No feature imports an adapter
(or the low-level Postmark client `src/lib/server/postmark.ts`) directly; they call
`getMailProvider(db, env)` / `mailSetup(db, env)` from `src/lib/server/mail`, which resolve the
credentials (`mail/config.ts`, Settings first) and call `providerFor(env, config)`. Helpers that
used to take a Postmark `{ token, stream, txStream }` bundle accept a provider or that bundle
(`asMailProvider`).

```ts
interface MailProvider {
  id: MailProviderId; // 'postmark' | 'resend' | 'ses' | 'smtp'
  label: string;
  maxBatch: number; // messages per sendBatch call
  streams: { broadcast: string; transactional: string };
  capabilities: {
    tracking: boolean; // can track opens and clicks itself
    suppressions: 'both' | 'read' | 'none';
    webhooks: boolean;
    inbound: boolean;
    domainApi: boolean;
    streams: boolean; // separate broadcast and transactional streams
  };
  sendBatch(messages: OutboundMessage[]): Promise<SendResult[]>; // one result per message, same order
  suppressions?: {
    list(since?: string): AsyncIterable<ProviderSuppression>;
    add(email: string, reason: 'bounce' | 'complaint' | 'unsubscribe'): Promise<{ ok: boolean; message?: string }>;
    remove(email: string, scope?: string): Promise<{ ok: boolean; message?: string }>; // scope: Postmark's stream
    addMany(emails: string[], reason: 'bounce' | 'complaint' | 'unsubscribe'): Promise<{ suppressed: number; failed: number }>;
    byEmail(): Promise<{ map: SuppressionMap; errors: string[]; read: number }>; // keyed by lowercased email
    scopes(): string[];
  };
  parseWebhook?(request: Request): Promise<MailEvent[]>; // throws WebhookAuthError on a bad signature
  domainStatus?(domain: string): Promise<DomainStatus>;
  check(fetchFn?: typeof fetch): Promise<ProviderCheck>; // Settings → Sending and Settings → Setup (sends nothing)
}
```

`OutboundMessage` is provider-neutral: from, to, reply-to, subject, HTML, text, headers
(`List-Unsubscribe`, `List-Unsubscribe-Post`, `Message-ID`), the stream (`broadcast` or
`transactional`), the tracking flags and metadata (campaign, contact and send ids). `SendResult` is
either a provider message id or a failure with `permanent: true | false`, so a refusal at send time
becomes a hard bounce. `MailEvent` is one of `delivery`, `open`, `click`, `bounce` (with `hard`),
`spam` or `unsubscribe`, with the provider message id, the address, the time, a dedupe key and the
raw payload for `events.detail`.

The shared send path (`sendCampaignEmail`) turns each `SendResult` into a `MailResult` for its
callers (Postmark's field names, `ErrorCode` 0 = accepted, plus `Permanent`; a Postmark result passes
through unchanged) and writes the provider's id to `recipients.provider` next to the message id
(migration `0134`; rows from before it are `postmark`, as is `replies.forward_provider` for older
forwards). The Postmark webhook keeps its route and processing at `/api/webhook`; the adapter's
`parseWebhook` maps the same payloads (`mapPostmarkEvent`) for the shared processing the new
providers' routes will use.

Steps:

1. **Adapter.** A new module in `src/lib/server/mail/` that maps `OutboundMessage` to the provider's
   API and back. Use `fetch` (or `cloudflare:sockets` for a raw protocol), no SDKs: it runs on
   Workers. Never log a request body, a recipient address or a credential; scrub credentials from
   error messages.
2. **Credentials.** Store them like the other integration secrets: an `integration_secrets` row
   sealed with `MAIL_TOKEN_KEY`, a Worker secret fallback, and a case in the credential resolver. New
   names go in `.dev.vars.reference` with an "Optional" comment.
3. **Registry.** Add the id to the provider list and a case in `providerFor`. Fill in
   `capabilities` honestly: Settings → Sending shows them, and the app turns on CRM tracking and DSN
   reading from them.
4. **Webhook.** A route at `src/routes/api/webhook/<id>/+server.ts` that calls `parseWebhook`, which
   checks the signature before reading anything else, then hands the events to the shared processing
   with its dedupe (`webhook-dedupe.ts`). Add the path to `PUBLIC_PREFIXES`.
5. **Settings and checks.** The provider's fields in Settings → Sending and its rows in
   `src/lib/server/setup-checks.ts`.
6. **Tests.** Recorded fixtures for the send request and response, webhook signature pass and fail,
   and the event mapping. The fake-provider tests from #700 check the hard rules for every provider:
   suppressed contacts are never sent to, broadcasts carry `List-Unsubscribe`, and events map to the
   same rows. Keep them passing.
