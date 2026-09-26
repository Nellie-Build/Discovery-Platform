# Responsive refinements — pending Companies integration

The approved desktop design is retained. These local changes make mobile statistics a compact two-column grid, prevent status badges from wrapping, and keep tender columns readable in a keyboard-accessible horizontal scroll region below 1280px.

Validation: 138 frontend tests passed; frontend typecheck and production build passed (existing bundle-size warning). Browser checks passed at 1440x1100, 768x1024 and 390x844, including two cards per row, card heights below 180px, one-line partial status, keyboard horizontal scrolling, no page overflow, linked tender groups and a workspace with only Tenders enabled. Screenshots use clearly marked test fixtures; no search runs or database writes.

The approved screenshots in the parent folder remain unchanged. Updated screenshots are in this folder, including dashboard-single-module-mobile.png, dashboard-single-module-desktop.png, tender-table-mobile.png and tender-table-tablet.png.

GitHub main was verified through the GitHub connector as 8a18e85. The direct Git fetch failed to connect to github.com. The original Companies module is already in that base; the user was asked whether integration should wait for feature/companies-quality. No main integration, new push, PR, merge or deployment has been performed in this refinement step. Await the requested Companies landing or clarification before integrating and opening the UI PR; rerun frontend checks after integration.
