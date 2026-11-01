/**
 * Every wedding-site page (site, guest portal, itinerary, gallery) draws its own light theme, so
 * the app's dark-mode tokens are reset to light here: shared controls (inputs, buttons, alerts)
 * stay readable on the light site when the phone is in dark mode.
 */
export default function SiteLayout({ children }: LayoutProps<"/[slug]">) {
  return <div className="site-light">{children}</div>;
}
