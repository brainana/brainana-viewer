// Minimal hyperscript helpers shared by the panels — declarative DOM without a framework.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  const { class: className, ...rest } = props
  if (className) el.className = className
  Object.assign(el, rest)
  for (const child of children) el.append(child)
  return el
}

export function field(labelText: string, input: HTMLElement): HTMLLabelElement {
  return h('label', { class: 'field' }, [h('span', {}, [labelText]), input])
}

export interface SelectOption {
  value: string
  label: string
}

export interface SelectField {
  element: HTMLLabelElement
  select: HTMLSelectElement
  setValue: (value: string) => void
  value: () => string
}

// A labelled `<select>` dropdown (label · select on one row). Replaces ad-hoc chip-row pickers so
// categories scale to more entries. `onChange` fires with the chosen option value.
export function selectField(labelText: string, options: SelectOption[], onChange: (value: string) => void): SelectField {
  const select = h(
    'select',
    {},
    options.map((o) => h('option', { value: o.value }, [o.label])),
  ) as HTMLSelectElement
  select.addEventListener('change', () => onChange(select.value))
  const element = h('label', { class: 'field inline select-field' }, [h('span', {}, [labelText]), select])
  return {
    element,
    select,
    setValue: (value) => {
      select.value = value
    },
    value: () => select.value,
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Adapt an async function for an API that expects a void-returning listener (addEventListener and
 * friends). Without this an `async` handler hands its promise to a caller that drops it, so a
 * rejection becomes an unhandled rejection: no message, no console entry, the UI simply stops
 * half-done. Here it becomes a logged error instead.
 *
 * A handler that reports its OWN failures (most do — a try/catch that writes to a status line) still
 * wants this wrapper: the catch below is the backstop for the paths that catch missed, not a
 * replacement for user-facing error handling.
 */
export function asyncHandler<E extends Event>(fn: (event: E) => Promise<void>): (event: E) => void {
  return (event: E) => {
    fn(event).catch((error: unknown) => {
      console.error('Unhandled error in an event handler:', error)
    })
  }
}
