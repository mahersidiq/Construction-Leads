const STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "follow_up", label: "Follow Up" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

const PROPERTY_TYPES = [
  { value: "", label: "All Types" },
  { value: "B1", label: "B1 - Apartments" },
  { value: "B2", label: "B2 - Duplexes" },
  { value: "B3", label: "B3 - Tri/Fourplex" },
  { value: "B4", label: "B4 - Mfg Housing" },
];

export default function FilterBar({ filters, onChange }) {
  const update = (key, value) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <div className="space-y-3">
      {/* Row 1: Search fields */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Search Address
          </label>
          <input
            type="text"
            value={filters.addressSearch}
            onChange={(e) => update("addressSearch", e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="e.g. Congress St"
          />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Search Owner
          </label>
          <input
            type="text"
            value={filters.ownerSearch}
            onChange={(e) => update("ownerSearch", e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="e.g. Woodbranch"
          />
        </div>
        <div className="w-28">
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Zip Code
          </label>
          <input
            type="text"
            value={filters.zipCode}
            onChange={(e) => update("zipCode", e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="77002"
          />
        </div>
      </div>

      {/* Row 2: Numeric filters and checkboxes */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Property Type
          </label>
          <select
            value={filters.propertyType}
            onChange={(e) => update("propertyType", e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {PROPERTY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
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
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="0"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Year From
          </label>
          <input
            type="number"
            min={1900}
            max={2030}
            value={filters.yearFrom}
            onChange={(e) => update("yearFrom", e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="1980"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Year To
          </label>
          <input
            type="number"
            min={1900}
            max={2030}
            value={filters.yearTo}
            onChange={(e) => update("yearTo", e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="2005"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Min Value ($)
          </label>
          <input
            type="number"
            min={0}
            value={filters.minValue}
            onChange={(e) => update("minValue", e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-28 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="0"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">
            Max Value ($)
          </label>
          <input
            type="number"
            min={0}
            value={filters.maxValue}
            onChange={(e) => update("maxValue", e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm w-28 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="any"
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
    </div>
  );
}
