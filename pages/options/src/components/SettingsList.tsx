import { useEffect, useState, type ReactNode } from 'react';

/*
 * Grouped list pieces in the spirit of the iOS Settings app: a small caps header over a
 * rounded card of rows, an explanation under the card, one control at the right of each row.
 */

export const SettingsGroup = ({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: ReactNode;
  children: ReactNode;
}) => (
  <section>
    {title && <h3 className="nb-label mb-1.5 px-4">{title}</h3>}
    <div className="overflow-hidden rounded-xl border border-nb-line bg-nb-tile shadow-nb">{children}</div>
    {footer && <p className="mt-1.5 px-4 text-xs leading-relaxed text-nb-muted">{footer}</p>}
  </section>
);

export const SettingsRow = ({
  title,
  badge,
  subtitle,
  htmlFor,
  children,
}: {
  title: string;
  badge?: string;
  subtitle?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
}) => (
  <div className="nb-row flex min-h-[52px] items-center justify-between gap-6 px-4 py-2.5">
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="flex items-center gap-2 text-[13.5px] font-medium text-nb-ink">
        {title}
        {badge && (
          <span className="rounded-full border border-nb-line px-1.5 text-[10px] font-medium uppercase tracking-wider text-nb-plan">
            {badge}
          </span>
        )}
      </label>
      {subtitle && <p className="mt-0.5 text-xs leading-snug text-nb-muted">{subtitle}</p>}
    </div>
    <div className="flex shrink-0 items-center gap-2">{children}</div>
  </div>
);

export const Toggle = ({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <button
    id={id}
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nb-llm disabled:cursor-not-allowed disabled:opacity-50 ${
      checked ? 'bg-nb-llm' : 'bg-nb-track'
    }`}>
    <span
      className={`absolute left-[2px] top-[2px] size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] ring-1 ring-black/5 transition-transform ${
        checked ? 'translate-x-4' : ''
      }`}
    />
  </button>
);

/** A whole number with a unit; half-typed values stay in the field and only valid ones are saved */
export const NumberField = ({
  id,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <span className="flex items-center gap-1.5 rounded-md border border-nb-line bg-nb-tile-2 px-2 py-1 focus-within:border-nb-llm">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
          const next = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(next) && next >= min && next <= max) onChange(next);
        }}
        onBlur={() => setDraft(String(value))}
        className="nb-number w-12 bg-transparent text-right text-sm tabular-nums text-nb-ink focus:outline-none"
      />
      {unit && <span className="text-xs text-nb-muted">{unit}</span>}
    </span>
  );
};

/** A 0-1 confidence as a slider with its value beside it */
export const ConfidenceSlider = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
}) => (
  <>
    <input
      id={id}
      type="range"
      min={0}
      max={1}
      step={0.05}
      value={value}
      onChange={e => onChange(Number.parseFloat(e.target.value))}
      className="w-36 accent-nb-llm"
    />
    <span className="w-8 text-right text-sm tabular-nums text-nb-ink-2">{value.toFixed(2)}</span>
  </>
);
