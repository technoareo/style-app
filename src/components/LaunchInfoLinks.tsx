/**
 * Build 032: ordinary same-origin anchors to the three launch-information routes (/privacy, /terms, /support).
 * They are plain links, not buttons and not a consent step: the routes redirect to wherever the operator
 * published each document (see src/server/launchInfo.ts), or show a fixed "not available" page if the operator
 * has not configured one. No value is read here, so nothing about the destination reaches the browser bundle.
 */
const LINKS = [
  ["/privacy", "Privacy information"],
  ["/terms", "Terms"],
  ["/support", "Support"],
] as const;

export function LaunchInfoLinks() {
  return (
    <nav className="launch-links" aria-label="Privacy information, terms and support">
      {LINKS.map(([href, label]) => (
        <a key={href} href={href} className="text-link">
          {label}
        </a>
      ))}
    </nav>
  );
}

/** One link for the photo-consent control; opens in a new tab so the upload in progress is not lost. */
export function PhotoPrivacyLink() {
  return (
    <small className="photo-privacy-link">
      How your photo is used: <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy information</a>
    </small>
  );
}
