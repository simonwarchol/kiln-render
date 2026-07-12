/** Shared toast notification — injects the element and returns a show() function. */

const DEFAULT_MESSAGE = 'Current view copied to clipboard';

export interface Toast {
  show(message?: string, durationMs?: number): void;
}

/** Mounts the toast element into the document and returns its controller. */
export function mountToast(defaultMessage: string = DEFAULT_MESSAGE): Toast {
  const el = document.createElement('div');
  el.id = 'toast';
  el.className = 'toast';
  el.textContent = defaultMessage;
  document.body.appendChild(el);

  return {
    show(message = defaultMessage, durationMs = 1500) {
      el.textContent = message;
      el.classList.add('visible');
      setTimeout(() => {
        el.classList.remove('visible');
        el.textContent = defaultMessage;
      }, durationMs);
    },
  };
}
