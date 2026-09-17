import '@testing-library/jest-dom/vitest';

// jsdom does not implement HTMLDialogElement.showModal()/close() (see jsdom#3294) — every test
// that renders the shared <Dialog> component (components/ui/dialog.tsx) needs these to exist.
// A minimal polyfill: track the `open` attribute the same way the real browser element does;
// nothing in this app depends on the dialog's own focus-trapping/backdrop behavior in tests.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
