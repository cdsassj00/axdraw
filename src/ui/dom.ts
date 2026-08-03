/** Tiny DOM helpers — enough structure to build the UI without a framework. */

type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = String(value);
    else if (key === "html") element.innerHTML = String(value);
    else if (key === "text") element.textContent = String(value);
    else if (key === "style" && typeof value === "object") {
      Object.assign(element.style, value as Partial<CSSStyleDeclaration>);
    } else if (key.startsWith("on") && typeof value === "function") {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "dataset" && typeof value === "object") {
      Object.assign(element.dataset, value as Record<string, string>);
    } else if (value === true) {
      element.setAttribute(key, "");
    } else {
      element.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

export interface ButtonOptions {
  icon?: string;
  label?: string;
  title?: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const element = h("button", {
    class: `btn${options.active ? " is-active" : ""}${options.className ? ` ${options.className}` : ""}`,
    type: "button",
    title: options.title ?? options.label,
    "aria-label": options.title ?? options.label,
    "aria-pressed": options.active ? "true" : undefined,
    disabled: options.disabled,
    onclick: options.onClick,
  });
  if (options.icon) {
    const span = document.createElement("span");
    span.innerHTML = options.icon;
    element.append(span.firstElementChild ?? span);
  }
  if (options.label) element.append(document.createTextNode(options.label));
  if (options.shortcut) {
    element.append(h("span", { class: "shortcut", text: options.shortcut }));
  }
  return element;
}

/** Close a floating element when the user clicks elsewhere or presses Escape. */
export function dismissable(element: HTMLElement, onDismiss: () => void): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (!element.contains(event.target as Node)) onDismiss();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") onDismiss();
  };
  // Defer so the click that opened the element does not immediately close it.
  setTimeout(() => {
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
  });
  return () => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}
