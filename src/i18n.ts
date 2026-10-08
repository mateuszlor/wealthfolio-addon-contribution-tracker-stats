import type { AddonTranslationBundle } from '@wealthfolio/addon-sdk';

/**
 * Translation resources for the addon.
 *
 * `en` is the fallback bundle (the host falls back to `en` for any language
 * that is missing), `pl` is the Polish translation.
 */
export const translations: Record<string, AddonTranslationBundle> = {
  en: {
    title: 'Contribution statistics',
    subtitle: 'Deposits recorded in Wealthfolio',
    totalContributions: 'Total contributed',
    contributionCount: 'Contributions',
    averagePerDeposit: 'Average per deposit',
    averageMonthly: 'Average per month',
    range: 'Period',
    granularity: 'Granularity',
    month: 'Month',
    day: 'Day',
    year: 'Year',
    contributionsCount_one: '{{count}} contribution',
    contributionsCount_other: '{{count}} contributions',
    noContributions: 'No contributions found yet.',
    allTime: 'All time',
    chooseCustomRange: 'Choose custom date range',
    applyRange: 'Apply',
    clearRange: 'Clear',
    hideAmounts: 'Hide amounts',
    showAmounts: 'Show amounts',
    loading: 'Loading contributions...',
    loadError: 'Could not load activities: {{message}}',
    chartAxis: 'Contributions',
  },
  pl: {
    title: 'Statystyki wpłat',
    subtitle: 'Wpłaty zarejestrowane w Wealthfolio',
    totalContributions: 'Łącznie wpłacono',
    contributionCount: 'Liczba wpłat',
    averagePerDeposit: 'Średnio na wpłatę',
    averageMonthly: 'Średnio na miesiąc',
    range: 'Okres',
    granularity: 'Agregacja',
    month: 'Miesiąc',
    day: 'Dzień',
    year: 'Rok',
    contributionsCount_one: '{{count}} wpłata',
    contributionsCount_few: '{{count}} wpłaty',
    contributionsCount_many: '{{count}} wpłat',
    contributionsCount_other: '{{count}} wpłat',
    noContributions: 'Brak wpłat do wyświetlenia.',
    allTime: 'Cały okres',
    chooseCustomRange: 'Wybierz własny zakres dat',
    applyRange: 'Zastosuj',
    clearRange: 'Wyczyść',
    hideAmounts: 'Ukryj kwoty',
    showAmounts: 'Pokaż kwoty',
    loading: 'Wczytywanie wpłat...',
    loadError: 'Nie udało się wczytać aktywności: {{message}}',
    chartAxis: 'Wpłaty',
  },
};
