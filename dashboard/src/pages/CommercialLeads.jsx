import { useEffect, useState, useCallback } from "react";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { ScoreBadge } from "../components/StatusBadge";

const STATUSES = ["new", "contacted", "follow_up", "won", "lost"];

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "follow_up", label: "Follow Up" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

const PROPERTY_TYPE_OPTIONS = [
  { value: "", label: "All Types" },
  { value: "hotel", label: "Hotel" },
  { value: "commercial", label: "Commercial" },
];

const DEFAULT_FILTERS = {
  status: "",
  minScore: "",
  yearFrom: "",
  yearTo: "",
  minValue: "",
  maxValue: "",
  addressSearch: "",
  ownerSearch: "",
  zipCode: "",
  propertyType: "",
  permitOnly: false,
  outOfStateOnly: false,
};

const COLUMNS = [
  { key: "property_address", label: "Address" },
  { key: "owner_name", label: "Owner" },
  { key: "owner_mail_address", label: "Mail Address" },
  { key: "year_built", label: "Year" },
  { key: "appraised_value", label: "Value" },
  { key: "property_type", label: "Type" },
  { key: "lead_score", label: "Score" },
  { key: "permit_flag", label: "Permit" },
];

function SortArrow({ col, sortCol, sortAsc }) {
  if (col !== sortCol) return <span className="text-gray-300 ml-1">↕</span>;
  return <span className="ml-1">{sortAsc ? "↑" : "↓"}</span>;
}

function formatCurrency(val) {
  if (val == null) return "--";
  return "$" + Number(val).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function PropertyTypeBadge({ type }) {
  if (!type) return <span className="text-gray-300">--</span>;
  const colors = type === "hotel"
    ? "bg-amber-100 text-amber-800"
    : "bg-indigo-100 text-indigo-800";
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${colors}`}>
      {type}
    </span>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="bg-white rounded-lg shadow px-4 py-3 border border-gray-200">
      <p className="text-xs font-medium text-gray-500 uppercase">{label}</p>
      <p className={`text-2xl font-bold ${color || "text-gray-900"}`}>{value}</p>
    </div>
  );
}

export default function CommercialLeads({ onBack, onLogout }) {
  const [allLeads, setAllLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sortCol, setSortCol] = useState("lead_score");
  const [sortAsc, setSortAsc] = useState(false);
  const [editingNotes, setEditingNotes] = useState(null);
  const [notesValue, setNotesValue] = useState("");

  const fetchLeads = useCallback(async () => {
    if (!supabaseConfigured) {
      setError("Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY environment variables.");
      setLoading(false);
      return;
    }
    setLoading(true);
    let allData = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error: fetchError } = await supabase
        .from("commercial_leads")
        .select("*")
        .order("lead_score", { ascending: false })
        .range(from, from + pageSize - 1);
      if (fetchError) {
        console.error("Error fetching commercial leads:", fetchError);
        setError("Failed to load commercial leads. Check your Supabase configuration.");
        setLoading(false);
        return;
      }
      allData = allData.concat(data || []);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    setAllLeads(allData);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(col === "property_address" || col === "owner_name");
    }
  };

  const filteredLeads = allLeads
    .filter((lead) => {
      if (filters.status && lead.status !== filters.status) return false;
      if (filters.minScore && lead.lead_score < Number(filters.minScore)) return false;
      if (filters.yearFrom && lead.year_built < Number(filters.yearFrom)) return false;
      if (filters.yearTo && lead.year_built > Number(filters.yearTo)) return false;
      if (filters.minValue && (lead.appraised_value || 0) < Number(filters.minValue)) return false;
      if (filters.maxValue && (lead.appraised_value || 0) > Number(filters.maxValue)) return false;
      if (filters.addressSearch) {
        const search = filters.addressSearch.toUpperCase();
        if (!(lead.property_address || "").toUpperCase().includes(search)) return false;
      }
      if (filters.ownerSearch) {
        const search = filters.ownerSearch.toUpperCase();
        if (!(lead.owner_name || "").toUpperCase().includes(search)) return false;
      }
      if (filters.zipCode) {
        if (!(lead.property_address || "").includes(filters.zipCode)) return false;
      }
      if (filters.propertyType && lead.property_type !== filters.propertyType) return false;
      if (filters.permitOnly && !lead.permit_flag) return false;
      if (filters.outOfStateOnly && !lead.out_of_state_owner) return false;
      return true;
    })
    .sort((a, b) => {
      const aVal = a[sortCol] ?? "";
      const bVal = b[sortCol] ?? "";
      let cmp;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else if (typeof aVal === "boolean" || typeof bVal === "boolean") {
        cmp = Number(aVal) - Number(bVal);
      } else {
        cmp = String(aVal).localeCompare(String(bVal));
      }
      return sortAsc ? cmp : -cmp;
    });

  const exportCsv = () => {
    const headers = ["property_address","owner_name","owner_mail_address","year_built","appraised_value","property_type","lead_score","permit_flag","permit_type","permit_status","out_of_state_owner","status","notes","acct_number"];
    const rows = filteredLeads.map((l) =>
      headers.map((h) => {
        const v = l[h];
        if (v == null) return "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")
    );
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `commercial-leads-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStatusChange = async (id, newStatus) => {
    if (!supabaseConfigured) return;
    await supabase.from("commercial_leads").update({ status: newStatus }).eq("id", id);
    fetchLeads();
  };

  const startEditNotes = (lead) => {
    setEditingNotes(lead.id);
    setNotesValue(lead.notes || "");
  };

  const saveNotes = async (id) => {
    if (!supabaseConfigured) return;
    await supabase.from("commercial_leads").update({ notes: notesValue }).eq("id", id);
    setEditingNotes(null);
    fetchLeads();
  };

  const handleNotesKeyDown = (e, id) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveNotes(id);
    }
    if (e.key === "Escape") {
      setEditingNotes(null);
    }
  };

  const update = (key, value) => {
    setFilters({ ...filters, [key]: value });
  };

  const total = allLeads.length;
  const newCount = allLeads.filter((l) => l.status === "new").length;
  const contacted = allLeads.filter((l) => l.status === "contacted").length;
  const won = allLeads.filter((l) => l.status === "won").length;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              Commercial Leads
            </h1>
            <p className="text-xs text-gray-500">Hotels &middot; Tenant Improvements &middot; Code Violations</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-400">
              {allLeads.length} total &middot; {filteredLeads.length} shown
            </span>
            <button
              onClick={exportCsv}
              className="text-sm text-green-600 hover:text-green-800 transition-colors font-medium"
            >
              Export CSV
            </button>
            <button
              onClick={onBack}
              className="text-sm text-blue-600 hover:text-blue-800 transition-colors font-medium"
            >
              Back to Dashboard
            </button>
            <button
              onClick={onLogout}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Summary Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Leads" value={total} />
          <StatCard label="New" value={newCount} color="text-blue-600" />
          <StatCard label="Contacted" value={contacted} color="text-purple-600" />
          <StatCard label="Won" value={won} color="text-green-600" />
        </div>

        {/* Filter Bar */}
        <div className="bg-white rounded-lg shadow border border-gray-200 p-4">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">Search Address</label>
                <input
                  type="text"
                  value={filters.addressSearch}
                  onChange={(e) => update("addressSearch", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="e.g. Westheimer"
                />
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">Search Owner</label>
                <input
                  type="text"
                  value={filters.ownerSearch}
                  onChange={(e) => update("ownerSearch", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="e.g. Marriott"
                />
              </div>
              <div className="w-28">
                <label className="block text-xs font-medium text-gray-500 mb-1">Zip Code</label>
                <input
                  type="text"
                  value={filters.zipCode}
                  onChange={(e) => update("zipCode", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="77002"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Property Type</label>
                <select
                  value={filters.propertyType}
                  onChange={(e) => update("propertyType", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {PROPERTY_TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
                <select
                  value={filters.status}
                  onChange={(e) => update("status", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Min Score</label>
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
                <label className="block text-xs font-medium text-gray-500 mb-1">Year From</label>
                <input
                  type="number"
                  min={1900}
                  max={2030}
                  value={filters.yearFrom}
                  onChange={(e) => update("yearFrom", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="1970"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Year To</label>
                <input
                  type="number"
                  min={1900}
                  max={2030}
                  value={filters.yearTo}
                  onChange={(e) => update("yearTo", e.target.value)}
                  className="border border-gray-300 rounded-md px-3 py-2 text-sm w-20 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="2010"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Min Value ($)</label>
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
                <label className="block text-xs font-medium text-gray-500 mb-1">Max Value ($)</label>
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
        </div>

        {/* Lead Table */}
        <div className="bg-white rounded-lg shadow border border-gray-200">
          {error ? (
            <div className="text-center py-12 text-red-600 text-sm">{error}</div>
          ) : loading ? (
            <div className="text-center py-12 text-gray-500">Loading commercial leads...</div>
          ) : filteredLeads.length === 0 ? (
            <div className="text-center py-12 text-gray-500">No leads match the current filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    {COLUMNS.map((col) => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key)}
                        className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
                      >
                        {col.label}
                        <SortArrow col={col.key} sortCol={sortCol} sortAsc={sortAsc} />
                      </th>
                    ))}
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Notes</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredLeads.map((lead) => (
                    <tr key={lead.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-sm text-gray-900 max-w-[220px] truncate" title={lead.property_address}>
                        {lead.property_address}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-600 max-w-[180px] truncate" title={lead.owner_name}>
                        {lead.owner_name}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500 max-w-[180px] truncate" title={lead.owner_mail_address}>
                        {lead.owner_mail_address || <span className="text-gray-300">--</span>}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-600">{lead.year_built}</td>
                      <td className="px-3 py-2 text-sm text-gray-600">{formatCurrency(lead.appraised_value)}</td>
                      <td className="px-3 py-2"><PropertyTypeBadge type={lead.property_type} /></td>
                      <td className="px-3 py-2"><ScoreBadge score={lead.lead_score} /></td>
                      <td className="px-3 py-2 text-sm">
                        {lead.permit_flag ? (
                          <span className="text-orange-600 font-medium text-xs">{lead.permit_status || "Yes"}</span>
                        ) : (
                          <span className="text-gray-400">--</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={lead.status || "new"}
                          onChange={(e) => handleStatusChange(lead.id, e.target.value)}
                          className="text-xs border border-gray-300 rounded-md px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>{s.replace("_", " ")}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-sm max-w-[150px]">
                        {editingNotes === lead.id ? (
                          <textarea
                            value={notesValue}
                            onChange={(e) => setNotesValue(e.target.value)}
                            onKeyDown={(e) => handleNotesKeyDown(e, lead.id)}
                            onBlur={() => saveNotes(lead.id)}
                            className="w-full text-xs border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            rows={2}
                            autoFocus
                          />
                        ) : (
                          <div
                            onClick={() => startEditNotes(lead)}
                            className="cursor-pointer text-xs text-gray-600 hover:text-gray-900 min-h-[1.5rem] truncate"
                            title="Click to edit"
                          >
                            {lead.notes || <span className="text-gray-300 italic">Add notes...</span>}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
