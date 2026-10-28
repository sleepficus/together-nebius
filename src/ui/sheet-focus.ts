/** Keep the phone sheet's keyboard loop on visible, sequential focus stops. */
export function trapSheetTab(panel: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const stops = [...panel.querySelectorAll<HTMLElement>('button,a[href],input,textarea,summary,[tabindex]')]
    .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0);
  const first = stops[0], last = stops.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first?.focus();
  }
}
