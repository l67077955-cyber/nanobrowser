import { useEffect, useRef } from 'react';
import type { IconType } from 'react-icons';
import { t } from '@extension/i18n';

/** One row of the palette that opens when the chat box starts with `/` */
export interface PaletteCommand {
  id: string;
  /** the small caps heading the row is listed under */
  group: string;
  label: string;
  /** a short note at the row's right: a shortcut, a time, where it goes */
  hint?: string;
  icon?: IconType;
  /** the row stands for the current state (the view or the action mode in use) */
  current?: boolean;
  run: () => void;
}

/** The commands whose label has every word of the query in it, in their order */
export function matchCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  return commands.filter(command => {
    const text = `${command.group} ${command.label}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** The list of commands above the chat box; the box keeps the focus and steers it with the arrow keys */
export default function CommandPalette({
  commands,
  selected,
  onPick,
  onHover,
}: {
  commands: PaletteCommand[];
  selected: number;
  onPick: (command: PaletteCommand) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div className="nb-palette" role="dialog" aria-label={t('chat_palette_a11y')}>
      {commands.length === 0 ? (
        <p className="nb-palette-empty">{t('chat_palette_empty')}</p>
      ) : (
        <ul ref={listRef} role="listbox" aria-label={t('chat_palette_a11y')}>
          {commands.map((command, index) => {
            const Icon = command.icon;
            const heading = index === 0 || commands[index - 1].group !== command.group;
            return (
              <li key={command.id} role="presentation">
                {heading && <span className="nb-label nb-palette-group">{command.group}</span>}
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === selected}
                  aria-current={command.current || undefined}
                  // keeps the focus in the chat box
                  onMouseDown={e => e.preventDefault()}
                  onMouseMove={() => index !== selected && onHover(index)}
                  onClick={() => onPick(command)}
                  title={command.label}>
                  {Icon ? <Icon aria-hidden /> : <i aria-hidden />}
                  <span className="nb-palette-label">{command.label}</span>
                  {command.hint && <small>{command.hint}</small>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="nb-palette-foot">{t('chat_palette_hint')}</p>
    </div>
  );
}
