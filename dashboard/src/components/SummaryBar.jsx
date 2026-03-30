function StatCard({ label, value, color }) {
  return (
    <div className="bg-white rounded-lg shadow px-4 py-3 border border-gray-200">
      <p className="text-xs font-medium text-gray-500 uppercase">{label}</p>
      <p className={`text-2xl font-bold ${color || "text-gray-900"}`}>
        {value}
      </p>
    </div>
  );
}

export default function SummaryBar({ leads }) {
  const total = leads.length;
  const newCount = leads.filter((l) => l.status === "new").length;
  const contacted = leads.filter((l) => l.status === "contacted").length;
  const won = leads.filter((l) => l.status === "won").length;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard label="Total Leads" value={total} />
      <StatCard label="New" value={newCount} color="text-blue-600" />
      <StatCard label="Contacted" value={contacted} color="text-purple-600" />
      <StatCard label="Won" value={won} color="text-green-600" />
    </div>
  );
}
