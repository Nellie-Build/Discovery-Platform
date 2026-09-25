// Side-effect imports only — each domain renderer registers itself with domains/registry.tsx.
// Adding a new domain module later means adding one more import line here, nothing else.
import './vacancies/renderer';
import './tenders/renderer';
import './companies/renderer';
