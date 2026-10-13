import {
  describeProgress,
  isActive,
  type JobSummary,
} from "../services/analysisClient";

/** Shows photo processing started earlier, from anywhere in the app. */
export function AnalysisBanner({
  jobs,
  onOpen,
}: {
  jobs: JobSummary[];
  onOpen: () => void;
}) {
  const active = jobs.find(isActive);
  const ready = jobs.find((j) => j.status === "completed");
  if (!active && !ready) return null;
  return (
    <div role="status" className="notice analysis-banner">
      <p>
        {active
          ? `Photo analysis in progress. ${describeProgress(active)}`
          : "Your photo analysis is ready to review."}
      </p>
      <button className="outline-button" onClick={onOpen}>
        {active ? "View photo progress" : "Review photo results"}
      </button>
    </div>
  );
}
