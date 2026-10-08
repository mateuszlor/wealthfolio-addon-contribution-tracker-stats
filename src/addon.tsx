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
