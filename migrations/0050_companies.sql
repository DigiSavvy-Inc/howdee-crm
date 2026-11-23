-- #166: Companies as a first-class entity (Integrations 1/5). Separate from the derived
-- lists(kind='company') groups (#47), which stay as-is: this table carries company-level
-- data (domain, website, notes, and later integrations) that a contact group can't.
CREATE TABLE companies (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	domain TEXT,
	website TEXT,
	notes TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- contacts.company (text) stays: display fallback + API compatibility. Writers set both.
ALTER TABLE contacts ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX idx_contacts_company_id ON contacts(company_id);

-- Backfill: one company per distinct (case-insensitive) trimmed name, then link by name.
-- OR IGNORE: "Acme" and "acme" collapse into the first one inserted (UNIQUE NOCASE).
INSERT OR IGNORE INTO companies (name)
	SELECT DISTINCT TRIM(company) FROM contacts WHERE TRIM(COALESCE(company, '')) <> '';
UPDATE contacts
	SET company_id = (SELECT co.id FROM companies co WHERE co.name = TRIM(contacts.company))
	WHERE TRIM(COALESCE(company, '')) <> '';
