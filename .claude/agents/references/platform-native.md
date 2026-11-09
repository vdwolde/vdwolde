# Platform-native lookup — does the platform already do this?

Read by the `design` lens when it tags a finding `native:`, and by anyone climbing rung 4 of
`CLAUDE.md` § Coding principles ("does a native platform feature cover it?"). Not loaded up
front. Each row: what people hand-roll or import a library for → what the platform ships.

**Check browser support before recommending a row.** Support moves; a feature that is
"baseline" today may not cover a project's stated target. Verify against the project's own
browser-support line (or caniuse) — never assert support from memory.

## HTML

| Hand-rolled or imported | Native |
| --- | --- |
| Modal / lightbox library, `z-index` overlay, focus trap by hand | `<dialog>` + `showModal()` (focus trap, `Esc`, backdrop, top layer) |
| Accordion / disclosure component | `<details>` / `<summary>` |
| Autocomplete dropdown for a short known list | `<input list>` + `<datalist>` |
| Date / time picker library | `<input type="date">`, `time`, `datetime-local`, `month`, `week` |
| Colour picker library | `<input type="color">` |
| Progress bar / gauge div with a width style | `<progress>` / `<meter>` |
| Range slider component | `<input type="range">` |
| Client-side form validation library for basic rules | `required`, `pattern`, `min`/`max`, `minlength`, `type=email\|url`, `setCustomValidity` |
| Tooltip / popover / dropdown positioned by JS | `popover` attribute + `popovertarget` (top layer, light-dismiss) |
| Lazy-loading library for images / iframes | `loading="lazy"`, `decoding="async"` |
| Responsive-image JS | `srcset` / `sizes` / `<picture>` |
| "Copy" fallbacks via a hidden textarea | `navigator.clipboard.writeText()` |

## CSS

| Hand-rolled or imported | Native |
| --- | --- |
| Sticky header via a scroll listener | `position: sticky` |
| Auto-growing textarea script | `field-sizing: content` |
| Scroll-snap carousel library (for a simple case) | `scroll-snap-type` / `scroll-snap-align` |
| Scroll-triggered fade-in via `IntersectionObserver` | `animation-timeline: view()` / scroll-driven animations |
| Aspect-ratio padding hack | `aspect-ratio` |
| Media-query breakpoints for a component's own layout | container queries (`@container`) |
| Margin / padding mirrored for RTL by hand | logical properties (`margin-inline`, `padding-block`, …) |
| JS computing a colour tint / shade | `color-mix()`, relative colour syntax |
| JS dark-mode toggle for the OS default | `prefers-color-scheme`, `color-scheme` |
| JS for reduced-motion users | `prefers-reduced-motion` |
| Sass variables for runtime theming | custom properties (`--token`) |
| Parent-styling-by-child JS class toggle | `:has()` |
| Smooth-scroll library | `scroll-behavior: smooth` |
| Truncate-to-N-lines script | `line-clamp` |
| Page / view transition library | View Transitions API |

## JavaScript / Web APIs

| Hand-rolled or imported | Native |
| --- | --- |
| `lodash.cloneDeep` / `JSON.parse(JSON.stringify())` | `structuredClone()` |
| `moment` / `dayjs` for formatting one date | `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat` |
| Number / currency formatting library | `Intl.NumberFormat` |
| Pluralisation helper | `Intl.PluralRules` |
| List-joining helper ("a, b and c") | `Intl.ListFormat` |
| `axios` for plain requests | `fetch` + `AbortController` (timeout via `AbortSignal.timeout()`) |
| `uuid` package | `crypto.randomUUID()` |
| `lodash.groupBy` | `Object.groupBy()` / `Map.groupBy()` |
| `lodash.uniq`, set operations | `Set` (and its set methods) |
| Query-string parsing library | `URL` / `URLSearchParams` |
| Scroll / visibility listeners for "is it on screen" | `IntersectionObserver` |
| Resize listeners on an element | `ResizeObserver` |
| Debounced storage polling across tabs | `BroadcastChannel`, the `storage` event |
| `lodash.get` / `_.isNil` | optional chaining `?.`, nullish `??` |
| Array helper libraries | `Array.prototype` (`at`, `flat`, `flatMap`, `findLast`, `toSorted`) |
| Event-emitter class | `EventTarget` / `CustomEvent` |
| Polling for the online state | `navigator.onLine` + `online` / `offline` events |

## Python (stdlib)

| Hand-rolled or imported | Native |
| --- | --- |
| Hand-written memo dict | `functools.lru_cache` / `functools.cache` |
| `requests` for one internal call in a stdlib-only tool | `urllib.request` (keep `requests` if already a dependency) |
| Manual path string joins | `pathlib.Path` |
| Hand-rolled argument parsing | `argparse` |
| Manual CSV splitting | `csv` |
| Custom record classes with only fields | `dataclasses` |
| `collections` re-implementations | `Counter`, `defaultdict`, `deque` |
| Temp-file juggling | `tempfile`, `shutil` |
| Retry loop with `sleep` around a subprocess | `subprocess.run(..., timeout=)` |

## .NET (BCL)

| Hand-rolled or imported | Native |
| --- | --- |
| JSON library for plain serialisation | `System.Text.Json` |
| Manual `HttpWebRequest` / string-built URLs | `HttpClient`, `UriBuilder` |
| Hand-written command-line parsing for a simple tool | `System.CommandLine`, or `args` for one flag |
| Manual string-building for paths | `Path.Combine`, `Path.GetRelativePath` |
| Hand-rolled process spawn via a joined string | `ProcessStartInfo.ArgumentList` (argv array, § Security defaults) |
| Lock-and-queue background worker | `System.Threading.Channels` |
| Custom retry loop | `Polly` only if already installed; otherwise a small bounded loop |

## Database

| Hand-rolled in app code | Native |
| --- | --- |
| Uniqueness check before insert | `UNIQUE` constraint (a check-then-insert races) |
| Referential-integrity checks in code | `FOREIGN KEY` (+ `ON DELETE`) |
| Value-range validation only in the app | `CHECK` constraint |
| Default values set in every caller | column `DEFAULT` |
| Application-side "updated at" bump | trigger, or `DEFAULT` / generated column |
| Pagination by loading all rows | `LIMIT` / `OFFSET` (or keyset) |
| App-side filtering, grouping, summing | `WHERE` / `GROUP BY` / aggregates |
| App-side `json` parsing to filter | JSON operators / generated columns (per engine) |

## Rules of use

- **Name the exact feature**, as in the tables, in a `native:` finding — "use the platform"
  is not actionable.
- **A native feature that is not yet Baseline for the project's target is not a finding.**
  Say `native (verify support): …` instead, so the author decides.
- **Keep a dependency that is already installed and used elsewhere** when the native
  version would only make one call site different (rung 5 before rung 4 is a consistency
  call, not a bug). Flag it as a Suggestion at most.
- These are platform facts, written fresh for this base; nothing here is copied text.
