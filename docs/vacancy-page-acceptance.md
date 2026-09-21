# When a page counts as one vacancy

`extractVacancyWithDiagnostic` (`domains/vacancies/src/extract-vacancy.ts`) decides per page. Order:

1. **JobPosting JSON-LD** — a vacancy (unchanged). `detailEvidence: json_ld`.
2. **Overview/listing look** — rejected (`overview_page`).
3. **Evidence score** (title, company, metadata, description, contact, application call to action) must reach 3, and the
   page needs job-specific evidence: explicit employment metadata (location, salary, hours, contract type), **or**
   description + a contact.
4. **Single-vacancy evidence** (new). The description + contact route alone is not enough, because a career-information page
   ("Working as a nurse", a long text and a "mail us" address) has exactly that. Without explicit employment metadata one more
   sign of ONE opportunity is required: a named contact person (`contact_person`) or a real application action —
   "Solliciteer" / "Apply", not "Bekijk vacature" (`apply_action`). Otherwise the page is rejected with
   `no_single_vacancy_evidence`.

`detailEvidence` (`json_ld`, `metadata`, `contact_person`, `apply_action`) is reported per accepted page in `pageDiagnostics`.
No hostname, URL path, profession word or candidate score takes part; a low-priority page may be visited and the extractor
alone decides.

Measured on the three live false positives (career-information pages: title +1, description from the `main` paragraphs +2,
a general mailbox inside `main` +2, sometimes a "Bekijk vacature" call to action +1, no metadata, no company → score 5–6):
all three now `no_single_vacancy_evidence`. Real vacancy pages without JSON-LD (the WBO and Varbi shapes) are accepted on
their employment metadata and are unaffected.

Known limit: a career page that also has an actual "Apply" button and a general mailbox still passes; separating that from a
vacancy needs more than these signals.
