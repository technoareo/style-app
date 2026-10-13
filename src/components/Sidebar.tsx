import { Heart, LogOut, Shirt, Sparkles, Sun } from "lucide-react";

export const TABS = ["Today", "My wardrobe", "Saved looks"] as const;
export type Tab = (typeof TABS)[number];
const ICONS = [Sun, Shirt, Heart];

type Props = {
  tab: Tab;
  onTab: (t: Tab) => void;
  profileId: string;
  profileName: string;
  onSignIn: () => void;
  onSignOut: () => void;
};

export function Sidebar({
  tab,
  onTab,
  profileId,
  profileName,
  onSignIn,
}: Props) {
  return (
    <aside className="sidebar">
      <a className="brand" href="#">
        <span className="brand-mark">
          <Sparkles size={19} />
        </span>{" "}
        style<span className="brand-light">studio</span>
      </a>
      <div className="side-label">YOUR SPACE</div>
      {TABS.map((x, i) => {
        const Icon = ICONS[i];
        return (
          <button
            key={x}
            className={`nav ${tab === x ? "active" : ""}`}
            onClick={() => onTab(x)}
          >
            <Icon size={17} /> {x}
          </button>
        );
      })}
      <div className="side-bottom">
        <div className="avatar">
          {(profileName || "My wardrobe")[0].toUpperCase()}
        </div>
        <div className="user-meta">
          <b>{profileId ? profileName || profileId : "Guest space"}</b>
          <span>Private account</span>
        </div>
        {profileId ? (
          <button
            className="icon-button"
            onClick={onSignIn}
            aria-label="Your account"
          >
            <LogOut size={16} />
          </button>
        ) : (
          <button className="text-link" onClick={onSignIn}>
            Sign in
          </button>
        )}
      </div>
    </aside>
  );
}
