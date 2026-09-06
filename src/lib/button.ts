/** Keep the label and dimensions stable while a native button is busy. */
export function setButtonLoading(button: HTMLButtonElement, loading: boolean): void {
  if ((button.dataset.loading === "true") === loading) return;

  if (loading) button.dataset.idleDisabled = String(button.disabled);
  button.dataset.loading = String(loading);
  button.disabled = loading || button.dataset.idleDisabled === "true";
  if (loading) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}
