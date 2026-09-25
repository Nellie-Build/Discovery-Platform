-- The companies module now has a real adapter (apps/api/src/domains/companies-adapter.ts, domains/companies). Its row in
-- the Module Registry (seeded as 'coming_soon' by 004_admin_modules.sql) gets its description and capabilities. The global
-- switch is deliberately left as it is: an admin enables the module (PATCH /admin/modules/companies). A module that is
-- off is shown as built-but-disabled ('disabled') instead of 'coming_soon'. It is NOT added to any package (module
-- packages, 009): no existing workspace gains access; an admin grants it per workspace or via a package. No table or
-- column is added: company profiles live in the generic discovery_records.domain_data like every other domain's.
UPDATE modules SET
  description = 'Branchegerichte B2B-bedrijvendiscovery: bedrijven vinden op activiteiten, producten, diensten, specialisaties, bedrijfsrol, afnemerssector en regio, met bewijs per criterium.',
  capabilities = '["web_search", "website"]'::jsonb,
  status = CASE WHEN enabled THEN 'active' ELSE 'disabled' END,
  version = '1.0.0',
  updated_at = now()
WHERE id = 'companies';
