/**
 * dsh-account-glance — host half.
 *
 * The plugin is a pure browser-side surface: it reads the account balance over
 * the existing `account` Remote namespace and the usage totals over dsh-usage's
 * loopback endpoint, then renders one card in the sidebar foot. Nothing has to
 * happen in the Host process, so this half only has to exist for the Loader row
 * to mount and for the client-modules scanner to publish the browser bundle.
 */

/** Apply the host half (no-op for a pure browser plugin). */
export function apply() {}
