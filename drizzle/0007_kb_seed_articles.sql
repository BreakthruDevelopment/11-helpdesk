-- Seed the knowledge base: 13 published articles and 2 drafts. Idempotent (slug is unique); author_id stays null.
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('reset-your-password', $kb$How to reset your password$kb$, $kb$If you can't sign in, reset your password yourself in under two minutes.

1. Open the sign-in page and choose **Forgot password**.
2. Enter the email address on your account.
3. Open the message we send you and follow the link. It works once and expires after an hour.
4. Choose a new password of at least 10 characters.

If the message doesn't arrive, check your spam folder and make sure you used the email address on the account. Support will never ask you for your password, in a ticket or anywhere else.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('billing-duplicate-charges', $kb$Billing: duplicate charges on your statement$kb$, $kb$Seeing two charges for the same plan is usually one of these:

- **A pending authorization.** Your bank may show a temporary hold next to the final charge. The hold drops off by itself, usually within 3 to 5 business days.
- **Two workspaces.** Each workspace is billed separately. Check **Settings > Billing** in each workspace you belong to.
- **A plan change mid-cycle.** Upgrading creates a prorated charge in addition to the regular one.

If none of these explains it, open a ticket and include the dates and the last four digits of the card. Never send a full card number. An agent will review the charges with you.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('update-your-email-address', $kb$Change the email address on your account$kb$, $kb$Go to **Settings > Profile**, enter the new address and confirm it from the message we send to that address. Until you confirm, sign-in keeps using the old address.

If you no longer have access to the old address, open a ticket from the new one and an agent will help you verify the account.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('export-your-data', $kb$Export your data to CSV$kb$, $kb$You can download everything in your workspace as CSV files.

1. Open **Settings > Data**.
2. Choose **Export** and pick what to include: records, comments, or both.
3. We prepare the files and notify you when they are ready, usually within a few minutes. Large workspaces can take longer.

Exports contain only what your role can see. Workspace owners can export everything.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('invoices-and-receipts', $kb$Find and download invoices and receipts$kb$, $kb$Invoices are listed under **Settings > Billing > History**. Choose any row to download a PDF.

To change the name or address printed on future invoices, edit **Billing details** on the same page. Past invoices can't be edited; open a ticket if a document needs correcting.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('cancel-your-subscription', $kb$Cancel or pause your subscription$kb$, $kb$Workspace owners can cancel under **Settings > Billing > Plan**. Access continues until the end of the period you already paid for, and your data stays available for 30 days afterwards so you can export it.

Cancelling stops future charges. It does not change charges that were already made.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('two-factor-authentication', $kb$Turn on two-factor authentication$kb$, $kb$Two-factor authentication asks for a code from an authenticator app in addition to your password.

1. Open **Settings > Security**.
2. Choose **Enable two-factor authentication** and scan the QR code with an authenticator app.
3. Enter the six-digit code to confirm, then save your recovery codes somewhere safe.

If you lose your phone and your recovery codes, open a ticket. We will verify your identity before turning it off.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('invite-team-members', $kb$Invite and manage team members$kb$, $kb$Owners and admins can invite people from **Settings > Team**. Enter an email address and choose a role: **Member**, **Admin** or **Owner**.

Invitations expire after 7 days and can be resent. To remove someone, open their row and choose **Remove**. Their past work stays in the workspace.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('dark-mode-and-appearance', $kb$Dark mode and appearance settings$kb$, $kb$There is no dark theme yet. It is on our list of requested features.

For now, your browser or operating system may offer a forced dark mode. You can also raise contrast and text size under **Settings > Appearance**. To add your vote for a dark theme, open a ticket describing how you would use it.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('api-keys', $kb$Create and rotate API keys$kb$, $kb$Create a key under **Settings > Developers**. The full key is shown once, so copy it into your password manager or secret store immediately.

To rotate a key, create a new one, switch your integration to it, then delete the old one. Treat keys like passwords: never paste them into a ticket. If a key leaks, delete it right away.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('delete-your-account-and-data', $kb$Delete your account and data$kb$, $kb$Workspace owners can delete a workspace under **Settings > Danger zone**. Deleting removes the workspace and its data from our systems after a 30-day recovery window.

To delete only your own account, open a ticket from the account's email address. Export anything you need first, because deletion can't be undone after the recovery window.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('service-status-and-outages', $kb$Check service status and report an outage$kb$, $kb$If pages fail to load for everyone on your team, check the status page first. It lists current incidents and maintenance.

If nothing is posted, open a ticket and describe what you see, when it started and how many people are affected. Tickets that report an outage are looked at first.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('support-response-times', $kb$How quickly will support reply?$kb$, $kb$We aim to send a first reply within a target time that depends on the priority of the ticket: from one hour for urgent problems to 24 hours for general questions. Calendar hours count, including nights and weekends.

When we are waiting for information from you, the resolution timer pauses, and it resumes when you reply. Adding detail up front, such as steps to reproduce and screenshots described in text, speeds things up.$kb$, 'published') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('internal-refund-policy-draft', $kb$DRAFT: refund and credit guidelines for agents$kb$, $kb$Internal guidance, not for publication yet.

Agents never promise refunds or credits in a first reply. Confirm the charge, gather dates and amounts, and hand the case to billing review. Wording for customers is still being written.$kb$, 'draft') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "kb_article" ("slug", "title", "body", "status") VALUES ('single-sign-on-setup-draft', $kb$DRAFT: Set up single sign-on$kb$, $kb$Single sign-on setup guide, still being reviewed.

Owners will connect an identity provider under **Settings > Security**. Steps for SAML and OIDC providers will be added once the beta ends.$kb$, 'draft') ON CONFLICT ("slug") DO NOTHING;
