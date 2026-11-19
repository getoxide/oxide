import { SearchIcon } from "@primer/octicons-react";

interface SurfaceSearchProps {
  /** Accessible name of the field; also the default placeholder. */
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  /** Escape in the field: clear the typed text and the search that is running. */
  onClear: () => void;
  /** Enter submits the query. Surfaces whose search costs a `gh` call opt in; debounced ones omit it. */
  onSubmit?: () => void;
  /** Controls that belong beside the field inside the form, such as the Pull request Mine chip. */
  children?: React.ReactNode;
}

/** The one search row of a Surface toolbar: 14px icon, `.search-field` and Escape-to-clear.
 *  The form keeps `.pr-search` so the toolbar's flexible-left contract holds, and Enter never
 *  reloads the page even on Surfaces that search as the user types. */
export function SurfaceSearch({ label, placeholder, value, onChange, onClear, onSubmit, children }: SurfaceSearchProps) {
  return (
    <form
      className="pr-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <label className="search-field">
        <SearchIcon size={14} />
        <input
          aria-label={label}
          placeholder={placeholder ?? label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClear();
          }}
        />
      </label>
      {children}
    </form>
  );
}
