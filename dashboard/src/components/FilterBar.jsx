const STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "follow_up", label: "Follow Up" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

export default function FilterBar({ filters, onChange }) {
  const update = (key, value) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <div className="flex flex-wrap gap-3 items-end">
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          Status
        </label>
        <select
          value={filters.status}
          onChange={(e) => update("status", e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">
          Min Score
        </label>
        <input
          type="number"
          min={0}
          max={100}
          value={filters.minScore}
          onChange={(e) => update("minScore", e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-24 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="0"
        />
      </div>
      <div className="flex items-center gap-4 py-2">
        <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.permitOnly}
            onChange={(e) => update("permitOnly", e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          Permit Flag
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={filters.outOfStateOnly}
            onChange={(e) => update("outOfStateOnly", e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          Out-of-State
        </label>
      </div>
    </div>
  );
}
