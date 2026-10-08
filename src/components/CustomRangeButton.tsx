import React from 'react';
import {
  Button,
  DatePickerWithRange,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@wealthfolio/ui';
import { useAddonTranslation } from '@wealthfolio/addon-sdk';

export interface CustomRangeButtonProps {
  /** Currently applied range, or undefined when an interval preset drives the window. */
  value: { from: Date | undefined; to: Date | undefined } | undefined;
  /** Fired on apply with a complete range, or undefined when cleared. */
  onApply: (range: { from: Date | undefined; to: Date | undefined } | undefined) => void;
}

/**
 * Custom range picker for the addon route.
 *
 * This replaces `@wealthfolio/ui`'s `DateRangeSelector`, which renders its own
 * preset pills *and* a calendar trigger. Combined with `IntervalSelector` that
 * produced two rows of pills, and because every preset was hidden the trigger
 * could never match one, so it always rendered in the filled "custom range"
 * variant instead of the ghost variant the application uses.
 *
 * Composing the built-in primitives keeps the application's own components while
 * giving full control over the control's appearance: a single ghost button.
 */
export function CustomRangeButton({ value, onApply }: CustomRangeButtonProps) {
  const { t } = useAddonTranslation();

  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<{ from: Date | undefined; to: Date | undefined }>(
    value ?? { from: undefined, to: undefined },
  );

  // Seed the draft from the applied value each time the popover opens, so a
  // cancelled edit does not leak into the next one.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (next) setDraft(value ?? { from: undefined, to: undefined });
      setOpen(next);
    },
    [value],
  );

  const complete = Boolean(draft.from && draft.to);

  const apply = React.useCallback(() => {
    if (!complete) return;
    onApply(draft);
    setOpen(false);
  }, [complete, draft, onApply]);

  const clear = React.useCallback(() => {
    setDraft({ from: undefined, to: undefined });
    onApply(undefined);
    setOpen(false);
  }, [onApply]);

  const isCustom = Boolean(value?.from && value?.to);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={isCustom ? 'default' : 'ghost'}
          size="sm"
          className="h-8 w-9 shrink-0 rounded-full p-0"
          aria-label={t('chooseCustomRange')}
          title={t('chooseCustomRange')}
        >
          <Icons.Calendar className="h-4 w-4" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-auto p-3">
        {/* `onDateChange` hands back `undefined` when the selection is cleared. */}
        <DatePickerWithRange
          date={draft}
          onDateChange={(next) =>
            setDraft({ from: next?.from, to: next?.to })
          }
        />

        <div className="flex items-center justify-between gap-2 pt-3">
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            {t('clearRange')}
          </Button>
          <Button type="button" size="sm" disabled={!complete} onClick={apply}>
            {t('applyRange')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
