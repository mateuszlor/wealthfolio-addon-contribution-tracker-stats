import React from 'react';
import { registerTranslations } from '@wealthfolio/addon-sdk';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';

import { translations } from './i18n';
// Declares the CSS custom properties the host's components style themselves
// from; see src/addon.css for why the sandbox does not provide them.
import './addon.css';
import { ContributionStatsPage } from './components/ContributionStatsPage';

export const ADDON_ID = 'contribution-tracker-stats';
export const ROUTE_ID = 'contribution-stats';

/**
 * Absolute path the host mounts this addon at.
 *
 * A contributed route without `path` means the addon root, so the runtime route
 * must be exactly `/addons/<manifest.id>`; registering `/<manifest.id>` leaves
 * the declared route id unresolvable ("Addon route ... is not available").
 *
 * Written as a literal, not interpolated, so `scripts/validate.mjs` can assert it
 * against `manifest.id` in the built bundle. Keep in sync - validation enforces it.
 */
const ROOT_PATH = '/addons/contribution-tracker-stats';

/** Props the host re-passes on every navigation; declared locally because the
 *  SDK exposes the type only as an internal contract. */
interface HostRouteProps {
  location?: unknown;
}

const enable: AddonEnableFunction = (ctx: AddonContext) => {
  // Register the addon translation bundles before the first render so the
  // sandbox i18n instance can resolve keys.
  registerTranslations(translations);

  // Runtime errors never reach the host log with a message when the thrown
  // value is not an Error (React 19 rethrows random objects), so the host's own
  // "runtime error: Uncaught " line stays empty and a blank page is
  // undiagnosable from the outside. Capture both channels here: console.error
  // and window error events from the sandbox document.
  const logRuntimeError = (origin: string) => (message: unknown) => {
    const detail =
      message instanceof Error
        ? `${message.name}: ${message.message}\n${message.stack ?? ''}`
        : typeof message === 'string' || typeof message === 'number' || typeof message === 'boolean'
          ? String(message)
          : safeStringify(message);
    ctx.api.logger?.error?.(`[runtime/${origin}] ${detail.slice(0, 1200)}`);
  };

  function safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value, Object.getOwnPropertyNames(value as object));
    } catch {
      return String(value);
    }
  }

  // React 19 routes thrown render errors through console.error first; the
  // sandbox's own console is separate, so hook it at the source.
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logRuntimeError('console.error')(args.length === 1 ? args[0] : args);
    originalConsoleError(...args);
  };

  window.addEventListener('error', (event) => {
    logRuntimeError('window.error')(event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    logRuntimeError('unhandledrejection')((event as PromiseRejectionEvent).reason);
  });

  // The host owns a single React root per addon and re-passes `location` on
  // every navigation, so we forward it through and never call createRoot here.
  const Route: React.FC<HostRouteProps> = (props) => (
    <ContributionStatsPage ctx={ctx} {...props} />
  );

  ctx.router.add({
    id: ROUTE_ID,
    path: ROOT_PATH,
    component: Route,
  });

  // No `ctx.sidebar.addItem` here: the sidebar entry and the route are declared
  // in manifest.json (`contributes`), so the host builds navigation without
  // booting the addon. Adding a runtime sidebar item pointing at the same path
  // registers a second navigation target with no matching runtime route, which
  // makes the declared route id unresolvable.
  ctx.api.logger?.info?.(`Contribution Tracker Stats enabled at ${ROOT_PATH}`);

  ctx.onDisable(() => {
    /* nothing to clean up: the host unmounts the route root */
  });
};

export default enable;
