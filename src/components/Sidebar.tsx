import { BarChart3, CalendarDays, LogOut, Plus, Shirt, Sparkles, Sun } from "lucide-react";

export const TABS = ["Today", "My wardrobe", "Add", "Plan", "Insights"] as const;
export type Tab = (typeof TABS)[number];
const ICONS = [Sun, Shirt, Plus, CalendarDays, BarChart3];
const LABELS: Record<Tab, string> = {
  Today: "Today",
  "My wardrobe": "Closet",
  Add: "Add",
  Plan: "Plan",
  Insights: "Insights",
};

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
            className={`nav ${x === "Add" ? "nav-add" : ""} ${tab === x ? "active" : ""}`}
            onClick={() => onTab(x)}
            aria-current={tab === x ? "page" : undefined}
          >
            <Icon size={18} /> <span>{LABELS[x]}</span>
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
