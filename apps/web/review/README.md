# UI refresh review

Branch: `feature/ui-refresh`, based on `8a18e85`. All tracked changes are under `apps/web`.

## Delivered

- Workspace dashboard with effective module access, actual API data, project activity, recent runs and recent discoveries.
- Shared domain grouping counts the six TED/TenderNed source records as three results. Run counters explicitly describe source records.
- Empty, loading and partial-error states. An unavailable collection is not presented as a zero total. Previous workspace data is hidden during a workspace switch.
- Fixed desktop sidebar, native modal mobile navigation, workspace selector, admin-only navigation, active module state, skip link and reduced-motion styling.
- Indigo design tokens, shared icons, stat cards, module cards, quieter cards/buttons/badges, accessible dialog names. Existing module forms, detail pages and administration inherit the shared styles.
- Project name filter, module-specific project links, new-project shortcut and links to a specific run. Project creation waits for verified module access.
- UI preview uses port **5174** with strict port checking.

## Review screenshots

These screenshots use **browser-intercepted test fixtures**, visibly named “testgegevens”; they are visual review examples, not production statistics. The application itself uses only the existing client/API. No data or search runs were created.

- [Desktop dashboard](dashboard-desktop.png)
- [Tablet dashboard](dashboard-tablet.png)
- [Mobile dashboard](dashboard-mobile.png)
- [Mobile navigation](navigation-mobile.png)
- [Tender results](tender-results-desktop.png)

## Validation

- `npm run typecheck -w apps/web`
- `npm run build -w apps/web`
- `npm run test -w apps/web` — 138 tests, 20 files.
- Chrome browser checks at 1440×1100, 768×1024 and 390×844: no page overflow, module filtering, six-to-three tender grouping, mobile navigation, Escape/focus restoration, workspace/module access changes and project creation dialog. No uncaught browser errors.

The build reports a bundle-size warning (the application includes the CPV vocabulary). This UI task does not change bundling or search behavior.

To repeat the browser check, start the frontend on `127.0.0.1:5174`, install Playwright in an isolated tools directory, set `UI_TEST_TOOLS` to that directory and run `node apps/web/scripts/verify-ui.mjs` from the repository root. It uses installed Chrome and intercepts every API request; mutations are rejected by the test.

## Scope and integration

No backend, database, migrations, API contracts, search logic or Companies-specific files changed. No merge to main and no deployment.

The local `feature/companies-quality` ref still pointed at the same base during the overlap check, so there were no committed conflicting changes to compare. Uncommitted work in that builder's worktree was not inspected. Shared integration points that could need review later are `pages/project-detail.tsx` (small run-link change), `pages/projects.tsx`, the app layout and shared UI components. Companies retains its own existing presentation and behavior.

Individual module form layouts and the existing English labels on older pages have not been comprehensively redesigned or translated; they inherit the shared design system. No fictional analytics or unavailable functionality was added to populate the dashboard.
