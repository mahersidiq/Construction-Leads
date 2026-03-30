const SCORE_COLORS = {
  high: "bg-green-100 text-green-800",
  medium: "bg-yellow-100 text-yellow-800",
  low: "bg-red-100 text-red-800",
};

function getScoreLevel(score) {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export function ScoreBadge({ score }) {
  const level = getScoreLevel(score);
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${SCORE_COLORS[level]}`}
    >
      {score}
    </span>
  );
}

const STATUS_COLORS = {
  new: "bg-blue-100 text-blue-800",
  contacted: "bg-purple-100 text-purple-800",
  follow_up: "bg-orange-100 text-orange-800",
  won: "bg-green-100 text-green-800",
  lost: "bg-gray-100 text-gray-500",
};

export function StatusBadge({ status }) {
  const label = status.replace("_", " ");
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${STATUS_COLORS[status] || STATUS_COLORS.new}`}
    >
      {label}
    </span>
  );
}
