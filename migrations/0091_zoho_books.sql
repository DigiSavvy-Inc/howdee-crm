-- #353: Zoho Books (read-only) — invoices, payments and balances on company records.
-- The OAuth config (data center, client id/secret, refresh token) is one sealed row in
-- integration_secrets (provider 'zoho_books'); the chosen organization lives in app_state.
--
-- company_zoho_contacts: a company ↔ Zoho customer link. A company may have several Zoho
-- customers; a Zoho customer belongs to one company. The cursors are the per-customer
-- incremental sync position (Zoho last_modified_time, ISO); NULL = backfill 24 months.
CREATE TABLE company_zoho_contacts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
	zoho_contact_id TEXT NOT NULL UNIQUE,
	contact_name TEXT NOT NULL,
	linked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	linked_at TEXT NOT NULL DEFAULT (datetime('now')),
	invoices_cursor TEXT,
	payments_cursor TEXT,
	last_synced_at TEXT,
	last_error TEXT
);
CREATE INDEX idx_company_zoho_contacts_company ON company_zoho_contacts(company_id);

-- Mirrors (derived — safe to drop and re-sync). Only rows for linked customers are stored;
-- unlinking deletes that customer's rows. Amounts are in the row's own currency_code.
CREATE TABLE zoho_invoices (
	invoice_id TEXT PRIMARY KEY,
	zoho_contact_id TEXT NOT NULL REFERENCES company_zoho_contacts(zoho_contact_id) ON DELETE CASCADE,
	invoice_number TEXT,
	status TEXT,
	date TEXT,
	due_date TEXT,
	total REAL,
	balance REAL,
	currency_code TEXT,
	zoho_url TEXT,
	last_modified TEXT
);
CREATE INDEX idx_zoho_invoices_contact ON zoho_invoices(zoho_contact_id, date);

CREATE TABLE zoho_payments (
	payment_id TEXT PRIMARY KEY,
	zoho_contact_id TEXT NOT NULL REFERENCES company_zoho_contacts(zoho_contact_id) ON DELETE CASCADE,
	payment_number TEXT,
	date TEXT,
	amount REAL,
	invoice_numbers TEXT,
	payment_mode TEXT,
	currency_code TEXT,
	last_modified TEXT
);
CREATE INDEX idx_zoho_payments_contact ON zoho_payments(zoho_contact_id, date);

-- Roll-ups (#168's company_metrics). Money is in the organization's base currency only
-- (billing_currency); invoices/payments in another currency are shown but not summed.
ALTER TABLE company_metrics ADD COLUMN ar_outstanding REAL;
ALTER TABLE company_metrics ADD COLUMN ar_overdue REAL;
ALTER TABLE company_metrics ADD COLUMN invoiced_12m REAL;
ALTER TABLE company_metrics ADD COLUMN paid_12m REAL;
ALTER TABLE company_metrics ADD COLUMN last_payment_at TEXT;
ALTER TABLE company_metrics ADD COLUMN last_invoice_at TEXT;
ALTER TABLE company_metrics ADD COLUMN billing_currency TEXT;
ALTER TABLE company_metrics ADD COLUMN zoho_synced_at TEXT;
