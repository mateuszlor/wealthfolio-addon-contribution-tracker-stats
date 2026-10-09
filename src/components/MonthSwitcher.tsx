import React from 'react';
import { useAddonTranslation } from '@wealthfolio/addon-sdk';
import {
  Button,
  Icons,
  MonthYearPicker,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@wealthfolio/ui';
import { formatMonthLabel } from '../lib/contributions';

export interface MonthSwitcherProps {
  /** The selected month, `YYYY-MM`. */
  value: string;
  /** Fired when the user moves to the adjacent or picks a month. */
  onChange: (key: string) => void;
  /** Earliest month with data, `YYYY-MM`, bounding the chevrons. */
  minMonth?: string;
  /** Locale for the label, e.g. `pl` renders "sty 2026". */
  locale: string;
}

function shiftMonth(key: string, delta: number): string {
  const [year, month] = key.split('-').map((part) => Number.parseInt(part, 10));
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Month navigation like the spending pages' month switcher: chevrons either
 * side of a label, and the label opens a month grid. `MonthYearPicker` is the
 * host's own grid-of-months control, so the calendar-with-days picker the
 * previous custom-range button showed is gone.
 */
export function MonthSwitcher({ value, onChange, minMonth, locale }: MonthSwitcherProps) {
  const { t } = useAddonTranslation();
  const [open, setOpen] = React.useState(false);

  const label = React.useMemo(() => {
    const [year, month] = value.split('-').map((part) => Number.parseInt(part, 10));
    return formatMonthLabel(new Date(year, month - 1, 1), locale);
  }, [value, locale]);

  const atStart = minMonth !== undefined && value <= minMonth;
  // The upper bound is the current month, not a data-driven one: an empty
  // future month is still a valid step while browsing.
  const nowKey = React.useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);
  const atEnd = value >= nowKey;

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        disabled={atStart}
        onClick={() => onChange(shiftMonth(value, -1))}
        aria-label={t('previousMonth')}
      >
        <Icons.ChevronLeft className="h-4 w-4" />
      </Button>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 min-w-28 justify-center px-2 text-sm font-medium"
            aria-label={t('chooseMonth')}
          >
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-3">
          <MonthYearPicker
            value={value}
            onChange={(next) => {
              onChange(next);
              setOpen(false);
            }}
            minDate={minMonth}
            maxDate={nowKey}
          />
        </PopoverContent>
      </Popover>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        disabled={atEnd}
        onClick={() => onChange(shiftMonth(value, 1))}
        aria-label={t('nextMonth')}
      >
        <Icons.ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
