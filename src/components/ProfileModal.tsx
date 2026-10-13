import { useState } from "react";
import { ChevronRight, UserPlus } from "lucide-react";
import { Dialog } from "./Dialog";

type Props = {
  signedIn: boolean;
  initialName: string;
  onSubmit: (name: string) => Promise<boolean>;
  onClose: () => void;
};

export function ProfileModal({
  signedIn,
  initialName,
  onSubmit,
  onClose,
}: Props) {
  const [name, setName] = useState(initialName);
  const submit = async () => {
    if (await onSubmit(name)) onClose();
  };

  return (
    <Dialog title="Switch local profile" onClose={onClose}>
      <div className="brand-mark">
        <UserPlus size={19} />
      </div>
      <span className="eyebrow">SEPARATE PERSONAL SPACES</span>
      <p>
        Each profile keeps its own wardrobe and saved look on this device. No
        account or email is needed.
      </p>
      <label htmlFor="profile-name">Profile name</label>
      <input
        id="profile-name"
        type="text"
        placeholder="e.g. Alex"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <button className="primary modal-submit" onClick={submit}>
        {signedIn ? "Open profile" : "Create / open profile"}{" "}
        <ChevronRight size={16} />
      </button>
      <small>
        Profiles organize wardrobes on this device. They are not
        password-protected accounts. Export and restore backups from the footer.
      </small>
    </Dialog>
  );
}
