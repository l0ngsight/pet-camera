/** Find a required page element and fail early if the page markup is out of sync. */
export function $<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required page element not found: ${selector}`);
  return element;
}
